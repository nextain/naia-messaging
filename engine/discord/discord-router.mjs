import { randomUUID } from "node:crypto";
import { getBackendAdapter, readOnlyBackendOptions } from "./adapters.mjs";
import { authorizeDiscordMessage } from "./discord-scope.mjs";
import { deliverJobResult, formatOperatorStatus, postDiscordDirectMessage } from "./discord-delivery.mjs";
import { runBackendAttempt } from "./backend-runner.mjs";
import { commandOptionsForProfile, configurationRevision, currentExecutionProfile, discordBindingIdentity, durableExecutionBinding, effectiveAllowedActions, participantAuthorityRevision, sameExecutionProfile } from "./execution-profile.mjs";
import { promptWithDiscordConversation } from "./discord-conversation.mjs";
import { MAX_REQUEST_TEXT_LENGTH, boundRequestPrompt, commandText, discordRequestText, parseDiscordDmRequest } from "./discord-prompt.mjs";
import { verifyAgentContextBeforeAttempt } from "./agent-context.mjs";
import { mutationWindowStatus } from "./mutation-window.mjs";
import { reportDiscordJobFailure } from "./discord-failure.mjs";
import { jobRevisionForExecutionProfile, sameExecutionProfileExceptAccess } from "./discord-routing.mjs";
import { AUTHORITY_UNAVAILABLE_NOTICE, PROMPT_INVALID_NOTICE, RUNTIME_INPUT_CHANGED_NOTICE, rejectDiscordAdmission, rejectRuntimeInputChange } from "./discord-admission.mjs";
import { isProjectPolicyReason, projectPolicyError } from "./project-policy-bridge.mjs";

const MAX_QUEUED_TURNS = 32;
const MAX_SCOPE_QUEUED_TURNS = 8;
const RECOVERY_REVIEW_PARKED_NOTICE = "이전 요청이 서비스 중단으로 끊겨 자동으로 이어서 실행하지 않았습니다. 필요하면 같은 요청을 다시 보내 주세요. / A previous request was interrupted and was not resumed automatically; send the same request again if you still need it.";
// Proactive notifications are restricted to one configured recipient. The model
// never supplies a recipient ID, and no other operator can be targeted.
//
// The recipient comes from the instance config, not from this file. A default
// baked in here would mean every workspace that clones this skill tries to DM
// a stranger, and it would publish that person's account ID in a public
// repository. When the field is unset the feature stays off.
export function proactiveDmRecipient(config) {
	const recipient = config?.discord?.proactiveDmRecipientUserId;
	if (typeof recipient !== "string" || !/^\d{17,20}$/.test(recipient)) return null;
	return config?.discord?.operatorUserIds?.includes(recipient) === true ? recipient : null;
}

function localOperatorSnowflake(nowMs) {
	const discordEpoch = 1_420_070_400_000n;
	const timestamp = BigInt(Math.max(0, Math.trunc(nowMs))) - discordEpoch;
	return ((timestamp << 22n) | BigInt(Math.floor(Math.random() * 4_194_304))).toString();
}

export function noProgressInterventionDue(job, nowMs, interventionMs) {
	const health = job?.activityHealth?.value;
	const reasonCode = job?.activityHealth?.reasonCode;
	if (health === "unresponsive" && reasonCode !== "owned_child_missing") return true;
	if (health !== "suspected_stalled" && !(health === "unresponsive" && reasonCode === "owned_child_missing")) return false;
	const lastProgressMs = Date.parse(job.lastProgressAt ?? job.updatedAt);
	return Number.isFinite(lastProgressMs) && nowMs - lastProgressMs >= interventionMs;
}

export { boundRequestPrompt, discordRequestText, transientPrompt } from "./discord-prompt.mjs";

export class DiscordMessageRouter {
	constructor({ config, store, token, botUserId, cwd, allowedPaths = [cwd], agentContexts = null, runtimeRoot, instance = "default", agentContextSnapshot = null, runtimeRevision = null, recoveryCodec = null, projectStatus = null, projectPolicy = null, runner = runBackendAttempt, deliver = deliverJobResult, directMessage = postDiscordDirectMessage, send = null, loadHistory = null, backendExecutables = {}, verifyRuntimeInputs = null, now = () => Date.now() }) {
		if (typeof send !== "function") throw new Error("confirmed Discord sender is required");
		if (verifyRuntimeInputs !== null && typeof verifyRuntimeInputs !== "function") throw new Error("runtime input verifier must be a function");
		if (projectPolicy !== null && typeof projectPolicy !== "function" && typeof projectPolicy?.check !== "function") throw new Error("project policy bridge must be callable");
		if (config.schemaVersion === 2) {
			if (!agentContextSnapshot || agentContextSnapshot.schemaVersion !== 1 || typeof agentContextSnapshot.contextHash !== "string" || typeof agentContextSnapshot.workspaceRoot !== "string" || typeof agentContextSnapshot.agentId !== "string") throw new Error("schema v2 requires a valid agent context snapshot");
			if (!config.agentProfiles && (cwd !== agentContextSnapshot.workspaceRoot || config.workspace?.agentId !== agentContextSnapshot.agentId)) throw new Error("schema v2 workspace identity does not match its context snapshot");
		}
		this.config = config;
		this.store = store;
		this.token = token;
		this.botUserId = botUserId;
		this.cwd = cwd;
		this.allowedPaths = [...allowedPaths];
		this.runtimeRoot = runtimeRoot;
		this.instance = instance;
		this.agentContextSnapshot = agentContextSnapshot;
		this.agentContexts = agentContexts ?? { default: { cwd, allowedPaths: [...allowedPaths], snapshot: agentContextSnapshot } };
		if (runtimeRevision !== null && !/^[a-f0-9]{40}$/.test(runtimeRevision)) throw new Error("managed runtime revision is invalid");
		this.runtimeRevision = runtimeRevision;
		this.runner = runner;
		this.deliver = deliver;
		if (typeof directMessage !== "function") throw new Error("direct message sender is required");
		this.directMessage = directMessage;
		this.send = send;
		this.loadHistory = loadHistory;
		this.backendExecutables = backendExecutables;
		this.verifyRuntimeInputs = verifyRuntimeInputs;
		this.recoveryCodec = recoveryCodec;
		this.projectStatus = projectStatus;
		this.projectPolicy = projectPolicy;
		this.now = now;
		this.threadParents = new Map();
		for (const binding of config.discord.bindings) {
			if (binding.kind === "thread") this.threadParents.set(binding.threadId, { parentChannelId: binding.channelId, guildId: binding.guildId });
		}
		this.queue = [];
		this.running = 0;
		this.runningScopes = new Set();
		this.maxConcurrent = config.runtime?.maxConcurrentJobs ?? 1;
		this.accepting = true;
		this.controllers = new Map();
		this.workItems = new Map();
		this.pendingDeliveries = new Set();
		this.pendingAcknowledgementFinalizers = new Set();
		this.pendingOutbound = new Set();
		this.outboundControllers = new Set();
		this.outboundClosed = false;
	}

	async onDispatch(type, data, sequence, { accessCeiling = null } = {}) {
		if (!this.accepting) return { state: "stopping" };
		if (type === "THREAD_CREATE" || type === "THREAD_UPDATE") {
			if (data?.id && data?.parent_id) this.threadParents.set(data.id, { parentChannelId: data.parent_id, guildId: data.guild_id });
			return { state: "thread_cached" };
		}
		if (type === "THREAD_LIST_SYNC") {
			for (const thread of data?.threads ?? []) if (thread?.id && thread?.parent_id) this.threadParents.set(thread.id, { parentChannelId: thread.parent_id, guildId: data.guild_id });
			return { state: "threads_cached" };
		}
		if (type !== "MESSAGE_CREATE") return { state: "ignored" };
		const authorization = authorizeDiscordMessage({ message: data, bindings: this.config.discord.bindings, operatorUserIds: this.config.discord.operatorUserIds, participantProfiles: this.config.discord.participantProfiles, botUserId: this.botUserId, threadParents: this.threadParents });
		const sourceMessageId = data.id;
		if (!authorization.allowed) {
			if (authorization.scope && sourceMessageId) this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode: authorization.reasonCode, dispatchSequence: sequence });
			return { state: "rejected", reasonCode: authorization.reasonCode };
		}
		try {
			this.#verifyRuntimeInputs({ agentContextId: authorization.binding?.agentProfileId ?? "default" });
		} catch (error) {
			if (error?.code !== "context_changed_restart_required") throw error;
			return rejectRuntimeInputChange({ store: this.store, sendControl: (input) => this.#sendControl(input), token: this.token, botUserId: this.botUserId, authorization, sourceMessageId, sequence });
		}
		const command = commandText(data, this.botUserId);
		if (/^!naia(?:\s|$)/i.test(command)) return this.#handleCommand({ command, authorization, sourceMessageId, sequence });
		if (authorization.binding.canStartConversation !== true) {
			this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode: "conversation_start_disabled", dispatchSequence: sequence });
			return { state: "rejected", reasonCode: "conversation_start_disabled" };
		}
		const queuedInScope = this.queue.filter((item) => item.scopeKey === authorization.scopeKey).length;
		if (this.queue.length >= MAX_QUEUED_TURNS || queuedInScope >= MAX_SCOPE_QUEUED_TURNS) {
			// Gateway RESUME 이 이미 판정한 메시지를 재생할 수 있다. 예약이 중복이면
			// 같은 거절 알림을 다시 보내지 않는다.
			const ingress = this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode: "request_queue_full", dispatchSequence: sequence });
			if (ingress.duplicate) return { state: "duplicate", reasonCode: "request_queue_full", jobId: ingress.jobId };
				void this.#sendControl({ token: this.token, channelId: authorization.scope.threadId ?? authorization.scope.channelId, botUserId: this.botUserId, content: "요청이 많아 이번 메시지를 처리하지 못했습니다. 잠시 뒤 다시 보내 주세요. / The request queue is full; please retry shortly.", nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise.catch(() => {});
			return { state: "rejected", reasonCode: "request_queue_full" };
		}
		let prompt;
		let currentRequest;
		let selected;
		let authority;
		let effectiveAccessCeiling;
		let windowClosed;
		try {
			currentRequest = discordRequestText(data, this.botUserId, { authorization, instance: this.instance });
			if (!currentRequest || currentRequest.length > MAX_REQUEST_TEXT_LENGTH) throw new Error("Discord prompt is empty or too large");
		} catch {
			return rejectDiscordAdmission({ store: this.store, sendControl: (input) => this.#sendControl(input), token: this.token, botUserId: this.botUserId, authorization, sourceMessageId, sequence, reasonCode: "prompt_invalid", content: PROMPT_INVALID_NOTICE });
		}
		let profileConfig;
		try {
			selected = this.#agentContext(authorization.binding);
			authority = this.#authority(authorization, selected.snapshot);
			({ accessCeiling: effectiveAccessCeiling, windowClosed } = this.#effectiveAccessCeiling(this.config.backend.selected, authority, accessCeiling));
			profileConfig = this.#profileConfig(authorization.binding);
		} catch {
			return rejectDiscordAdmission({ store: this.store, sendControl: (input) => this.#sendControl(input), token: this.token, botUserId: this.botUserId, authorization, sourceMessageId, sequence, reasonCode: "authority_unavailable", content: AUTHORITY_UNAVAILABLE_NOTICE });
		}
		try {
			prompt = boundRequestPrompt(currentRequest, profileConfig, authority, selected.snapshot, effectiveAccessCeiling, { windowClosed });
		} catch {
			return rejectDiscordAdmission({ store: this.store, sendControl: (input) => this.#sendControl(input), token: this.token, botUserId: this.botUserId, authorization, sourceMessageId, sequence, reasonCode: "prompt_invalid", content: PROMPT_INVALID_NOTICE });
		}
		const jobId = randomUUID();
		const backendId = this.config.backend.selected;
		const adapter = getBackendAdapter(backendId);
		const channelId = authorization.scope.threadId ?? authorization.scope.channelId;
		const executionProfile = this.#executionProfile(backendId, authority, effectiveAccessCeiling);
		const commandOptions = this.#withBackendOptions(backendId, commandOptionsForProfile(executionProfile));
		const recoveryPayload = { schemaVersion: 2, currentRequest, channelId, scopeKey: authorization.scopeKey, executionProfile, accessCeiling: effectiveAccessCeiling, participantUserId: authorization.scope.authorId, bindingIdentity: authority.bindingIdentity, authorityRevision: authority.authorityRevision ?? null, configRevision: configurationRevision(this.config), contextHash: selected.snapshot?.contextHash ?? null, agentProfileId: authorization.binding.agentProfileId ?? "default", runtimeRevision: this.runtimeRevision };
		if (this.config.schemaVersion === 2) recoveryPayload.originalAccessCeiling = accessCeiling;
		const recoveryEnvelope = this.recoveryCodec?.seal(JSON.stringify(recoveryPayload)) ?? null;
		const jobRevision = jobRevisionForExecutionProfile(this.config, this.runtimeRevision, executionProfile);
		const executionBinding = this.config.schemaVersion === 2 && executionProfile.access === "read-only" ? durableExecutionBinding({ config: this.config, instance: this.instance, agentContextSnapshot: selected.snapshot, participantUserId: authorization.scope.authorId, binding: authorization.binding, executionProfile }) : null;
		const item = { jobId, backendId, prompt, currentRequest, channelId, scopeKey: authorization.scopeKey, sourceMessageId, allowedUserIds: authorization.binding.allowedUserIds, binding: authorization.binding, participantUserId: authorization.scope.authorId, authority, commandOptions, executionProfile, accessCeiling: effectiveAccessCeiling, ...(this.config.schemaVersion === 2 ? { originalAccessCeiling: accessCeiling, windowClosed } : {}), agentContext: selected, policyPhase: "enqueue" };
		try {
			if (this.projectPolicy !== null) this.#ensureMutationWindowOpen(item);
			this.#projectPolicyCheck(item, "accept");
		} catch (error) {
			if (!isProjectPolicyReason(error?.code) && error?.code !== "project_policy_route_unavailable") throw error;
			return this.#rejectProjectPolicyIngress({ authorization, sourceMessageId, sequence, reasonCode: error.code });
		}
		const ingress = this.store.acceptIngressAndCreateJob({ sourceMessageId, scopeKey: authorization.scopeKey, jobId, dispatchSequence: sequence, backendId, revision: jobRevision, backendCapabilities: adapter.capabilities, activityDetail: adapter.activityDetail, jobType: "conversation", requestExcerpt: currentRequest,
			softSilenceMs: (this.config.runtime?.softSilenceSeconds ?? 120) * 1_000, recoveryEnvelope, executionBinding, now: this.#nowIso() });
		if (ingress.duplicate) return { state: "duplicate", jobId: ingress.jobId };
		this.workItems.set(jobId, item);
		if (windowClosed) {
			try { this.store.recordEvent({ jobId, source: "helper", kind: "profile_replaced", safePayload: { reasonCode: "mutation_window_closed" } }); }
			catch {}
		}
		this.#sendOperatorResponse(item);
		this.queue.push(item);
		this.#drain();
		void this.projectScope({ scopeKey: authorization.scopeKey, channelId }).catch(() => {});
		return { state: "accepted", jobId };
	}

	async submitOperatorRequest({ channelId, authorId, content, access = null }) {
		if (!/^\d{17,20}$/.test(channelId ?? "") || !/^\d{17,20}$/.test(authorId ?? "") || typeof content !== "string" || !content.trim() || content.length > 4_000) {
			return { state: "rejected", action: "submit", reasonCode: "invalid_operator_submission" };
		}
		const binding = this.config.discord.bindings.find((candidate) =>
			candidate.operatorActions === true
			&& candidate.canStartConversation === true
			&& candidate.allowedUserIds.includes(authorId)
			&& (candidate.threadId ?? candidate.channelId) === channelId);
		if (!binding || !this.config.discord.operatorUserIds.includes(authorId)) return { state: "rejected", action: "submit", reasonCode: "operator_binding_unavailable" };
		const data = {
			id: localOperatorSnowflake(this.now()),
			channel_id: channelId,
			...(binding.guildId ? { guild_id: binding.guildId } : {}),
			author: { id: authorId, bot: false },
			content: binding.respondWhen === "mentioned" ? `<@${this.botUserId}> ${content.trim()}` : content.trim(),
			mentions: binding.respondWhen === "mentioned" ? [{ id: this.botUserId }] : [],
		};
		// 상한은 낮추는 방향으로만 받는다. 다른 값이 오면 권한을 넓히려는 시도로 본다.
		if (access !== null && access !== "read-only") return { state: "rejected", action: "submit", reasonCode: "invalid_access_attenuation" };
		const result = await this.onDispatch("MESSAGE_CREATE", data, null, { accessCeiling: access });
		return { ...result, action: "submit", semantics: access === "read-only" ? "owner_controlled_read_only_submission" : "owner_controlled_operator_submission" };
	}

	async #handleCommand({ command, authorization, sourceMessageId, sequence }) {
		const ingress = this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "handled", reasonCode: "status_command", dispatchSequence: sequence });
		if (ingress.duplicate) return { state: "duplicate" };
		const parts = command.trim().split(/\s+/);
		const action = (parts[1] ?? "status").toLowerCase();
		const allScopes = parts[2]?.toLowerCase() === "all";
		let content;
		if (action === "status") {
			if (allScopes && !authorization.isOperator) content = "이 바인딩에서는 전체 작업을 볼 수 없습니다.";
			else {
				const jobs = allScopes ? this.store.listJobs() : this.store.listJobsForScope(authorization.scopeKey);
				content = formatOperatorStatus(this.store.status(), jobs);
			}
		} else if (action === "jobs") {
			const jobs = this.store.listJobsForScope(authorization.scopeKey).slice(0, 8);
			content = jobs.length ? jobs.map((job) => `${job.jobId}: ${job.lifecycle} / ${job.activityHealth.value} / ${job.currentActivity ?? job.safeSummary}`).join("\n") : "이 대화 범위에는 작업이 없습니다.";
		} else if (action === "job" && parts[2]) {
			const job = this.store.getJob(parts[2], { includeEvents: false });
			content = job && (job.scopeKey === authorization.scopeKey || authorization.isOperator) ? `${job.jobId}: ${job.lifecycle} / ${job.activityHealth.value} (${job.activityHealth.reasonCode}) / ${job.currentActivity ?? job.safeSummary}` : "이 대화 범위에서 볼 수 없는 작업입니다.";
		} else content = "사용법: !naia status | jobs | job <id>";
		const channelId = authorization.scope.threadId ?? authorization.scope.channelId;
		await this.#sendControl({ token: this.token, channelId, botUserId: this.botUserId, content, nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise;
		return { state: "command_handled", action };
	}

	#drain() {
		while (this.running < this.maxConcurrent && this.queue.length) {
			const index = this.queue.findIndex((candidate) => !candidate.scopeKey || !this.runningScopes.has(candidate.scopeKey));
			if (index < 0) break;
			const [item] = this.queue.splice(index, 1);
			this.running += 1;
			if (item.scopeKey) this.runningScopes.add(item.scopeKey);
			void this.#run(item).finally(() => {
				this.running -= 1;
				if (item.scopeKey) this.runningScopes.delete(item.scopeKey);
				this.#drain();
			});
		}
	}

	#commandOptions(backendId, authority = null) {
		return this.#withBackendOptions(backendId, commandOptionsForProfile(this.#executionProfile(backendId, authority)));
	}

	#withBackendOptions(backendId, options) {
		const profile = this.config.backend.profiles?.[backendId];
		// 읽기 전용 자식에게는 네트워크와 자격 증명을 주지 않는다. 의미상으로도
		// 맞고, 이걸 빼지 않으면 codex read-only + networkAccess 조합이 실행 인자
		// 검증에서 바로 거절되어 시간창 강등·읽기 전용 제출·자동 복구·컷오버
		// canary 가 통째로 실패한다.
		const readOnly = readOnlyBackendOptions(backendId, options);
		const withCommon = {
			...options,
			...(profile?.model ? { model: profile.model } : {}),
			networkAccess: readOnly ? false : this.config.runtime?.networkAccess === true,
			credentialProfiles: readOnly ? [] : [...(this.config.runtime?.credentialProfiles ?? [])],
		};
		return backendId === "codex" || backendId === "grok" ? {
			...withCommon,
			costProfile: profile?.costProfile ?? "balanced",
			...(profile?.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
		} : withCommon;
	}

	#profileConfig(binding) {
		const profile = binding?.agentProfileId ? this.config.agentProfiles?.[binding.agentProfileId] : null;
		return profile ? { ...this.config, workspace: profile.workspace, persona: profile.persona } : this.config;
	}

	#agentContext(binding) {
		const id = binding?.agentProfileId ?? "default";
		const context = this.agentContexts[id];
		if (!context) throw new Error("binding agent context is unavailable");
		return context;
	}

	#authority(authorization, snapshot = this.agentContextSnapshot) {
		if (this.config.schemaVersion !== 2) return authorization;
		const identity = discordBindingIdentity(authorization.binding);
		const actions = effectiveAllowedActions(this.config, authorization);
		const authorityRevision = participantAuthorityRevision({
			workspaceIdentity: `${snapshot?.agentId}\0${snapshot?.workspaceRoot}`,
			bindingIdentity: identity,
			participantUserId: authorization.scope.authorId,
			participantProfile: authorization.participantProfile,
			effectiveActions: actions,
			permissionProfileEpoch: this.config.runtime?.permissionProfileEpoch ?? "default",
		});
		return { ...authorization, bindingIdentity: identity, authorityRevision, contextHash: snapshot?.contextHash };
	}

	#effectiveAccessCeiling(backendId, authority, originalAccessCeiling) {
		const requestedProfile = this.#executionProfile(backendId, authority, originalAccessCeiling);
		const status = mutationWindowStatus(authority?.participantProfile?.mutationWindow, this.now());
		const windowClosed = requestedProfile.access !== "read-only" && status.configured && !status.allowed;
		// When the native project policy is bound, it owns the participant-window
		// decision. Attenuating the request here would bypass that policy.
		return { accessCeiling: windowClosed && this.projectPolicy === null ? "read-only" : originalAccessCeiling, windowClosed };
	}

	#projectPolicyCheck(item, phase) {
		if (this.projectPolicy === null) return null;
		if (item.executionProfile?.access === "read-only") throw projectPolicyError("project_policy_participant_rejected");
		const participantProfile = this.config.discord.participantProfiles?.[item.participantUserId] ?? item.authority?.participantProfile ?? {};
		const context = item.agentContext ?? this.#agentContext(item.binding);
		const input = {
			schemaVersion: 1,
			participantUserId: item.participantUserId,
			bindingIdentity: item.authority?.bindingIdentity ?? discordBindingIdentity(item.binding),
			participantProfile: { ...participantProfile, discordUserId: item.participantUserId },
			backendId: item.backendId,
			cwd: context.cwd,
			allowedPaths: [...context.allowedPaths],
			access: item.executionProfile.access,
			jobId: item.jobId ?? null,
			phase,
			nowMs: this.now(),
		};
		let result;
		try {
			result = typeof this.projectPolicy === "function" ? this.projectPolicy(input) : this.projectPolicy.check(input);
		} catch (error) {
			const code = isProjectPolicyReason(error?.code) || error?.code === "project_policy_route_unavailable" ? error.code : "project_policy_rejected";
			throw projectPolicyError(code);
		}
		if (result && typeof result.then === "function") throw projectPolicyError("project_policy_rejected");
		if (!result || result.allowed !== true) {
			const code = isProjectPolicyReason(result?.reasonCode) ? result.reasonCode : "project_policy_rejected";
			throw projectPolicyError(code);
		}
		if (result.participantUserId !== input.participantUserId || result.bindingIdentity !== input.bindingIdentity) throw projectPolicyError("project_policy_authority_changed");
		if (result.cwd !== input.cwd || !Array.isArray(result.allowedPaths) || result.allowedPaths.length !== input.allowedPaths.length || result.allowedPaths.some((path, index) => path !== input.allowedPaths[index])) throw projectPolicyError("project_policy_workspace_mismatch");
		if (result.access !== input.access) throw projectPolicyError("project_policy_contract_invalid");
		return result;
	}

	#rejectProjectPolicyIngress({ authorization, sourceMessageId, sequence, reasonCode }) {
		const ingress = this.store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode, dispatchSequence: sequence });
		if (ingress.duplicate) return { state: "duplicate", reasonCode, jobId: ingress.jobId };
		void this.#sendControl({ token: this.token, channelId: authorization.scope.threadId ?? authorization.scope.channelId, botUserId: this.botUserId, content: "프로젝트 정책에 따라 이번 쓰기/실행 요청을 처리하지 못했습니다. 정책 상태를 확인한 뒤 다시 시도해 주세요. / Project policy rejected this write or execution request; review the policy state and retry.", nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise.catch(() => {});
		return { state: "rejected", reasonCode };
	}

	#mutationWindow(item) {
		return this.config.discord?.participantProfiles?.[item.participantUserId]?.mutationWindow
			?? item?.authority?.participantProfile?.mutationWindow;
	}

	#ensureMutationWindowOpen(item) {
		// A queued job that was admitted while the window was closed has already
		// been downgraded to read-only and is safe to run. This check protects a
		// writable job from a close between queue admission and child spawn.
		if (item.executionProfile?.access === "read-only") return;
		let status;
		try { status = mutationWindowStatus(this.#mutationWindow(item), this.now()); }
		catch {
			if (this.projectPolicy !== null) throw projectPolicyError("project_policy_participant_rejected");
			throw Object.assign(new Error("participant mutation window is invalid"), { code: "mutation_window_closed" });
		}
		if (status.allowed) return;
		if (this.projectPolicy !== null) throw projectPolicyError("project_policy_window_closed");
		throw Object.assign(new Error("mutation window is closed"), { code: "mutation_window_closed" });
	}

	#reconcileMutationWindow(item) {
		// With the native policy bound, leave the writable profile intact until the
		// policy check rejects it; automatic read-only downgrading would bypass it.
		if (this.projectPolicy !== null) return item;
		// Envelopes created before this field existed retain their legacy behavior.
		if (!Object.hasOwn(item, "originalAccessCeiling")) return item;
		// A job admitted while the mutation window was closed is durably read-only
		// until an explicit retry. Opening the clock must not silently widen queued
		// or automatically recovered work.
		if (item.originalAccessCeiling === null && item.accessCeiling === "read-only" && item.executionProfile?.access === "read-only") return item;
		const { accessCeiling, windowClosed } = this.#effectiveAccessCeiling(item.backendId, item.authority, item.originalAccessCeiling);
		if (item.accessCeiling === accessCeiling && item.windowClosed === windowClosed) return item;
		const selected = item.agentContext ?? this.#agentContext(item.binding);
		const executionProfile = this.#executionProfile(item.backendId, item.authority, accessCeiling);
		const commandOptions = this.#withBackendOptions(item.backendId, commandOptionsForProfile(executionProfile));
		const prompt = boundRequestPrompt(item.currentRequest, this.#profileConfig(item.binding), item.authority, selected.snapshot, accessCeiling, { windowClosed });
		try {
			this.store.recordEvent({ jobId: item.jobId, source: "helper", kind: "profile_replaced", safePayload: windowClosed ? { reasonCode: "mutation_window_closed" } : {} });
		} catch {}
		return { ...item, accessCeiling, windowClosed, prompt, executionProfile, commandOptions, agentContext: selected };
	}

	#currentAuthority(item) {
		const participantUserId = item.participantUserId;
		const expectedBindingIdentity = item.authority?.bindingIdentity ?? (item.binding ? discordBindingIdentity(item.binding) : null);
		const binding = this.config.discord.bindings.find((candidate) => discordBindingIdentity(candidate) === expectedBindingIdentity && candidate.allowedUserIds.includes(participantUserId));
		const participantProfile = this.config.discord.participantProfiles?.[participantUserId];
		if (!binding || !participantProfile) throw new Error("current participant binding is unavailable");
		const selected = this.#agentContext(binding);
		const authorization = {
			allowed: true,
			binding,
			participantProfile,
			isOperator: this.config.discord.operatorUserIds.includes(participantUserId) && binding.operatorActions === true,
			scope: { ...(item.authority?.scope ?? {}), authorId: participantUserId },
		};
		return { authority: this.#authority(authorization, selected.snapshot), binding, selected };
	}

	#executionBinding(item, selected) {
		if (this.config.schemaVersion !== 2 || item.executionProfile?.access !== "read-only") return null;
		return durableExecutionBinding({ config: this.config, instance: this.instance, agentContextSnapshot: selected.snapshot, participantUserId: item.participantUserId, binding: item.binding, executionProfile: item.executionProfile });
	}

	#recoveryAuthority(payload) {
		if (this.config.schemaVersion !== 2) throw new Error("legacy recovery requires review");
		if (payload?.schemaVersion !== 2 || typeof payload.participantUserId !== "string" || typeof payload.bindingIdentity !== "string") throw new Error("recovery authority is missing");
		if (!/^[a-f0-9]{40}$/.test(payload.runtimeRevision ?? "") || payload.runtimeRevision !== this.runtimeRevision) throw new Error("recovery runtime changed");
		const binding = this.config.discord.bindings.find((candidate) => discordBindingIdentity(candidate) === payload.bindingIdentity && candidate.allowedUserIds.includes(payload.participantUserId));
		const participantProfile = this.config.discord.participantProfiles?.[payload.participantUserId];
		if (!binding || !participantProfile) throw new Error("recovery participant authority changed");
		const selected = this.#agentContext(binding);
		if ((payload.agentProfileId ?? "default") !== (binding.agentProfileId ?? "default") || payload.contextHash !== selected.snapshot?.contextHash || payload.configRevision !== configurationRevision(this.config)) throw new Error("recovery configuration changed");
		const authorization = {
			allowed: true,
			binding,
			participantProfile,
			isOperator: this.config.discord.operatorUserIds.includes(payload.participantUserId) && binding.operatorActions === true,
			scope: { authorId: payload.participantUserId },
		};
		const authority = this.#authority(authorization, selected.snapshot);
		if (payload.authorityRevision !== authority.authorityRevision) throw new Error("recovery participant authority changed");
		return authority;
	}

	#recoveryNoticeChannelForPayload(payload) {
		const participantUserId = payload?.participantUserId;
		const bindingIdentity = payload?.bindingIdentity;
		if (typeof participantUserId !== "string" || typeof bindingIdentity !== "string") return null;
		const binding = this.config.discord.bindings.find((candidate) => discordBindingIdentity(candidate) === bindingIdentity && candidate.allowedUserIds.includes(participantUserId));
		const participantProfile = this.config.discord.participantProfiles?.[participantUserId];
		if (!binding || !participantProfile) return null;
		return this.#recoveryNoticeChannel(binding, payload.channelId);
	}

	#executionProfile(backendId, authority = null, accessCeiling = null) {
		return currentExecutionProfile(this.config, backendId, authority, { accessCeiling });
	}

	#nowIso() {
		return new Date(this.now()).toISOString();
	}

	#verifyRuntimeInputs(input = {}) {
		try {
			return this.verifyRuntimeInputs?.(input);
		} catch (error) {
			if (error && typeof error === "object" && typeof error.code === "string") throw error;
			const normalized = new Error(error?.message ?? "runtime input verification failed");
			normalized.code = "context_changed_restart_required";
			normalized.cause = error;
			throw normalized;
		}
	}


	#noProgressInterventionMs() {
		return (this.config.runtime?.noProgressInterventionSeconds ?? this.config.runtime?.softSilenceSeconds ?? 120) * 1_000;
	}

	#noProgressIsDue(job, nowMs) {
		return noProgressInterventionDue(job, nowMs, this.#noProgressInterventionMs());
	}

	#runOutbound(operation) {
		const controller = new AbortController();
		if (this.outboundClosed) controller.abort("shutdown");
		this.outboundControllers.add(controller);
		let pending;
		pending = Promise.resolve()
			.then(() => operation(controller.signal))
			.finally(() => {
				this.outboundControllers.delete(controller);
				this.pendingOutbound.delete(pending);
			});
		this.pendingOutbound.add(pending);
		return { controller, promise: pending };
	}

	#sendControl(input) {
		return this.#runOutbound((signal) => this.send({ ...input, signal }));
	}

	projectScope(input) {
		if (!this.projectStatus) return Promise.resolve();
		return this.#runOutbound((signal) => this.projectStatus({ ...input, signal })).promise;
	}

	#sendOperatorResponse(item) {
		const deadlineMs = (this.config.runtime?.operatorResponseSeconds ?? 30) * 1_000;
		let deadline;
		let finalizeMissed;
		const outbound = this.#sendControl({ token: this.token, channelId: item.channelId, botUserId: this.botUserId, content: "[메시지 받음]", nonce: randomUUID().replaceAll("-", "").slice(0, 24) });
		const sendOutcome = outbound.promise
			.then((receipt) => receipt?.state === "confirmed" ? "operator_response_sent" : "operator_response_missed", () => "operator_response_missed");
		const deadlineOutcome = new Promise((resolveDeadline) => {
			finalizeMissed = () => {
				outbound.controller.abort("operator_response_timeout");
				resolveDeadline("operator_response_missed");
			};
			deadline = setTimeout(finalizeMissed, deadlineMs);
			deadline.unref?.();
		});
		this.pendingAcknowledgementFinalizers.add(finalizeMissed);
		const pending = Promise.race([sendOutcome, deadlineOutcome])
			.then((kind) => {
				try { this.store.recordEvent({ jobId: item.jobId, source: "helper", kind, safePayload: {} }); } catch {}
			})
			.finally(() => {
				clearTimeout(deadline);
				this.pendingAcknowledgementFinalizers.delete(finalizeMissed);
				this.pendingDeliveries.delete(pending);
			});
		this.pendingDeliveries.add(pending);
	}

	#operatorResponseFinalized(jobId) {
		const events = this.store.getJob(jobId)?.events ?? [];
		return events.some((event) => event.kind === "operator_response_sent" || event.kind === "operator_response_missed");
	}

	async #run(item) {
		const controller = new AbortController();
		this.controllers.set(item.jobId, controller);
		try {
			if (controller.signal.aborted) return;
			const selectedAtStart = item.agentContext ?? this.#agentContext(item.binding);
			this.#verifyRuntimeInputs({ agentContextId: item.binding?.agentProfileId ?? "default", agentContext: selectedAtStart });
			item = this.#reconcileMutationWindow(item);
			const currentProfile = this.#executionProfile(item.backendId, item.authority, item.accessCeiling ?? null);
			if (!sameExecutionProfile(item.executionProfile ?? currentProfile, currentProfile)) {
				this.store.recordEvent({ jobId: item.jobId, source: "helper", kind: "profile_replaced", safePayload: {} });
				item = { ...item, executionProfile: currentProfile, commandOptions: this.#withBackendOptions(item.backendId, commandOptionsForProfile(currentProfile)) };
			}
			this.workItems.set(item.jobId, item);
			this.#ensureMutationWindowOpen(item);
			this.#projectPolicyCheck(item, item.policyPhase ?? "enqueue");
			let prompt = item.prompt;
			if (this.loadHistory && item.sourceMessageId) {
				let loaded;
				try { loaded = await this.loadHistory({ token: this.token, channelId: item.channelId, beforeMessageId: item.sourceMessageId, botUserId: this.botUserId, allowedUserIds: item.allowedUserIds, participantProfiles: this.config.discord.participantProfiles, requesterUserId: item.participantUserId, historyVisibility: item.binding?.historyVisibility ?? "shared", signal: controller.signal }); }
				catch (error) { if (error && typeof error === "object") error.code = "discord_history_load_failed"; throw error; }
				if (loaded?.state === "loaded") prompt = promptWithDiscordConversation(prompt, loaded.history, item.currentRequest);
			}
			const selected = item.agentContext ?? this.#agentContext(item.binding);
			if (selected.snapshot) verifyAgentContextBeforeAttempt(selected.snapshot);
			const preSpawnCheck = this.verifyRuntimeInputs || selected.snapshot || item.originalAccessCeiling !== undefined || this.projectPolicy !== null ? () => {
				this.#verifyRuntimeInputs({ agentContextId: item.binding?.agentProfileId ?? "default", agentContext: selected });
				if (selected.snapshot) verifyAgentContextBeforeAttempt(selected.snapshot);
				this.#ensureMutationWindowOpen(item);
				this.#projectPolicyCheck(item, "pre_spawn");
			} : null;
			const result = await this.runner({ store: this.store, jobId: item.jobId, backendId: item.backendId, prompt, cwd: selected.cwd, allowedPaths: selected.allowedPaths, runtimeRoot: this.runtimeRoot, executable: this.backendExecutables[item.backendId], commandOptions: item.commandOptions ?? this.#commandOptions(item.backendId, item.authority), executionProfile: item.executionProfile, signal: controller.signal, preSpawnCheck });
			if (result.backendOutcome !== "success") {
				await this.#reportFailure(item);
				return;
			}
			if (!result.transientResult) throw new Error("backend returned no deliverable final result");
			let finalContent = result.transientResult;
			const dmRequest = parseDiscordDmRequest(finalContent);
			if (dmRequest) {
				const recipient = proactiveDmRecipient(this.config);
				let receipt = { state: "failed", reasonCode: recipient ? "dm_delivery_failed" : "fixed_recipient_not_authorized" };
				if (recipient && effectiveAllowedActions(this.config, item.authority).includes("reply")) receipt = await this.directMessage({ token: this.token, userId: recipient, content: dmRequest.content, nonce: randomUUID().replaceAll("-", "").slice(0, 24), botUserId: this.botUserId, signal: controller.signal });
				finalContent = receipt.state === "confirmed" ? dmRequest.successReply : dmRequest.failureReply;
			}
			await this.deliver({ store: this.store, jobId: item.jobId, attemptId: result.attemptId, token: this.token, botUserId: this.botUserId, channelId: item.channelId, content: finalContent, signal: controller.signal });
		} catch (error) {
			const job = this.store.getJob(item.jobId);
			if (job && !["failed", "cancelled", "completed", "recovery_review"].includes(job.lifecycle)) {
				if (controller.signal.aborted && controller.signal.reason === "operator_cancel") {
					try { this.store.recordEvent({ jobId: item.jobId, attemptId: job.attemptId, source: "helper", kind: "cancelled", safePayload: {} }); } catch {}
				} else {
					const reasonCode = new Set(["context_changed_restart_required", "discord_history_load_failed", "backend_version_probe_failed", "backend_authentication_failed", "backend_invocation_invalid", "backend_spawn_failed", "mutation_window_closed"]).has(error?.code) || isProjectPolicyReason(error?.code) || error?.code === "project_policy_route_unavailable" ? error.code : "internal_error";
					try { this.store.recordEvent({ jobId: item.jobId, attemptId: job.attemptId, source: "helper", kind: "failed", safePayload: { reasonCode } }); } catch {}
				}
			}
			await this.#reportFailure(item);
		} finally {
			this.controllers.delete(item.jobId);
			this.workItems.delete(item.jobId);
			const job = this.store.getJob(item.jobId, { includeEvents: false });
				if (job?.scopeKey) void this.projectScope({ scopeKey: job.scopeKey, channelId: item.channelId }).catch(() => {});
		}
	}

	async #reportFailure(item) {
		const job = this.store.getJob(item.jobId, { includeEvents: false });
		const reasonCode = String(job?.latestSafeError ?? "").match(/^Job failed: ([a-z0-9_]+)$/)?.[1] ?? "internal_error";
		if (job && ["failed", "recovery_review"].includes(job.lifecycle) && (isProjectPolicyReason(reasonCode) || reasonCode === "project_policy_route_unavailable")) {
			try {
				await this.#sendControl({ token: this.token, channelId: item.channelId, botUserId: this.botUserId, content: "작업을 완료하지 못했습니다. 프로젝트 정책이 이번 쓰기/실행 요청을 허용하지 않았습니다. 정책 상태를 확인한 뒤 다시 시도해 주세요. / Project policy rejected this write or execution request; review the policy state and retry.", nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise;
			} catch {}
			return;
		}
		await reportDiscordJobFailure({ item, store: this.store, token: this.token, botUserId: this.botUserId, sendControl: (input) => this.#sendControl(input) });
	}

	async waitForIdle({ includeDeliveries = true } = {}) {
		while (this.running > 0 || this.queue.length > 0 || (includeDeliveries && this.pendingDeliveries.size > 0)) await new Promise((resolve) => setTimeout(resolve, 5));
	}

	cancelJob(jobId) {
		const queuedIndex = this.queue.findIndex((item) => item.jobId === jobId);
		if (queuedIndex >= 0) {
			this.queue.splice(queuedIndex, 1);
			this.workItems.delete(jobId);
			this.store.recordEvent({ jobId, source: "helper", kind: "cancel_requested", safePayload: {} });
			this.store.recordEvent({ jobId, source: "helper", kind: "cancelled", safePayload: {} });
			return { state: "accepted", action: "cancel", jobId, target: "queued" };
		}
		const controller = this.controllers.get(jobId);
		if (!controller || controller.signal.aborted) return { state: "rejected", action: "cancel", jobId, reasonCode: "job_not_active" };
		const job = this.store.getJob(jobId, { includeEvents: false });
		this.store.recordEvent({ jobId, attemptId: job?.attemptId ?? undefined, source: "helper", kind: "cancel_requested", safePayload: {} });
		controller.abort("operator_cancel");
		return { state: "accepted", action: "cancel", jobId, target: "running" };
	}

	replaceJob(jobId, { action = "restart", amendment = null } = {}) {
		if (!new Set(["restart", "amend"]).has(action)) return { state: "rejected", action, jobId, reasonCode: "invalid_control_action" };
		if (action === "amend" && (typeof amendment !== "string" || !amendment.trim() || amendment.length > 4_000)) return { state: "rejected", action, jobId, reasonCode: "amendment_invalid" };
		if (!this.recoveryCodec) return { state: "rejected", action, jobId, reasonCode: "recovery_codec_unavailable" };
		const sourceJob = this.store.getJob(jobId, { includeEvents: false });
		if (!sourceJob) return { state: "rejected", action, jobId, reasonCode: "job_not_found" };
		const activeItem = this.workItems.get(jobId) ?? this.queue.find((candidate) => candidate.jobId === jobId);
		let item = activeItem;
		if (activeItem && Object.hasOwn(activeItem, "originalAccessCeiling")) {
			try {
				const { authority, binding, selected } = this.#currentAuthority(activeItem);
				const { accessCeiling, windowClosed } = this.#effectiveAccessCeiling(activeItem.backendId, authority, activeItem.originalAccessCeiling);
				const executionProfile = this.#executionProfile(activeItem.backendId, authority, accessCeiling);
				item = {
					...activeItem,
					authority,
					binding,
					agentContext: selected,
					accessCeiling,
					windowClosed,
					executionProfile,
					commandOptions: this.#withBackendOptions(activeItem.backendId, commandOptionsForProfile(executionProfile)),
				};
			} catch {
				return { state: "rejected", action, jobId, reasonCode: "recovery_binding_changed" };
			}
		}
		if (!item) {
			if (sourceJob.lifecycle !== "failed") return { state: "rejected", action, jobId, reasonCode: "job_not_restartable" };
			const envelope = this.store.loadJobRecovery(jobId);
			if (!envelope) return { state: "rejected", action, jobId, reasonCode: "recovery_envelope_unavailable" };
			try {
				const payload = JSON.parse(this.recoveryCodec.open(envelope));
				const hasOriginalAccessCeiling = Object.hasOwn(payload, "originalAccessCeiling");
				const storedAccessCeiling = payload.accessCeiling ?? null;
				const originalAccessCeiling = hasOriginalAccessCeiling ? payload.originalAccessCeiling : storedAccessCeiling;
				if (originalAccessCeiling !== null && originalAccessCeiling !== "read-only") throw new Error("recovery access ceiling is invalid");
				if (typeof payload.currentRequest !== "string" || !payload.currentRequest || payload.currentRequest.length > MAX_REQUEST_TEXT_LENGTH || !/^\d{17,20}$/.test(payload.channelId)) throw new Error("recovery payload is invalid");
				const authority = this.#recoveryAuthority(payload);
				const binding = authority.binding;
				const agentContext = this.#agentContext(binding);
				const { accessCeiling, windowClosed } = hasOriginalAccessCeiling
					? this.#effectiveAccessCeiling(sourceJob.backendId, authority, originalAccessCeiling)
					: { accessCeiling: storedAccessCeiling, windowClosed: false };
				const executionProfile = this.#executionProfile(sourceJob.backendId, authority, accessCeiling);
				const profileMatches = hasOriginalAccessCeiling
					? sameExecutionProfileExceptAccess(payload.executionProfile, executionProfile)
					: sameExecutionProfile(payload.executionProfile, executionProfile);
				if (!profileMatches) throw new Error("recovery execution profile changed");
				item = {
					jobId,
					backendId: sourceJob.backendId,
					currentRequest: payload.currentRequest,
					channelId: payload.channelId,
					scopeKey: typeof payload.scopeKey === "string" ? payload.scopeKey : null,
					participantUserId: payload.participantUserId,
					authority,
					allowedUserIds: binding.allowedUserIds,
					accessCeiling,
					...(hasOriginalAccessCeiling ? { originalAccessCeiling } : {}),
					windowClosed,
					commandOptions: this.#withBackendOptions(sourceJob.backendId, commandOptionsForProfile(executionProfile)),
					executionProfile,
					binding,
					agentContext,
				};
			} catch {
				return { state: "rejected", action, jobId, reasonCode: "recovery_binding_changed" };
			}
		}
		const currentRequest = action === "amend" ? `${item.currentRequest}\n\nOperator amendment:\n${amendment.trim()}` : item.currentRequest;
		if (currentRequest.length > MAX_REQUEST_TEXT_LENGTH) return { state: "rejected", action, jobId, reasonCode: "amendment_too_large" };
		const replacementJobId = randomUUID();
		const selected = item.agentContext ?? this.#agentContext(item.binding);
		const executionProfile = this.#executionProfile(item.backendId, item.authority, item.accessCeiling ?? null);
		const replacementPrompt = boundRequestPrompt(currentRequest, this.#profileConfig(item.binding), item.authority, selected.snapshot, item.accessCeiling ?? null, { windowClosed: item.windowClosed === true });
		const envelopePayload = {
			schemaVersion: 2,
			currentRequest,
			channelId: item.channelId,
			scopeKey: item.scopeKey,
			executionProfile,
			accessCeiling: item.accessCeiling ?? null,
			participantUserId: item.participantUserId,
			bindingIdentity: item.authority?.bindingIdentity,
			authorityRevision: item.authority?.authorityRevision ?? null,
			configRevision: configurationRevision(this.config),
			contextHash: selected.snapshot?.contextHash ?? null,
			agentProfileId: item.binding?.agentProfileId ?? "default",
			runtimeRevision: this.runtimeRevision,
		};
		if (Object.hasOwn(item, "originalAccessCeiling")) envelopePayload.originalAccessCeiling = item.originalAccessCeiling;
		const replacementEnvelope = this.recoveryCodec.seal(JSON.stringify(envelopePayload));
		const executionBinding = this.#executionBinding({ ...item, executionProfile }, selected);
		this.store.createJob({ jobId: replacementJobId, backendId: item.backendId, revision: jobRevisionForExecutionProfile(this.config, this.runtimeRevision, executionProfile), backendCapabilities: sourceJob.backendCapabilities, activityDetail: sourceJob.activityDetail, jobType: "conversation", scopeKey: item.scopeKey, softSilenceMs: sourceJob.softSilenceMs, recoveryEnvelope: replacementEnvelope, executionBinding });
		const replacement = { ...item, jobId: replacementJobId, prompt: replacementPrompt, currentRequest, executionProfile, commandOptions: this.#withBackendOptions(item.backendId, commandOptionsForProfile(executionProfile)), sourceMessageId: null, policyPhase: "retry" };
		this.workItems.set(replacementJobId, replacement);
		if (activeItem) this.cancelJob(jobId);
		else this.store.deleteJobRecovery(jobId);
		this.queue.push(replacement);
		this.#drain();
		return { state: "accepted", action, jobId, replacementJobId, semantics: activeItem ? "cancel_and_queue_replacement" : "terminal_retry_from_encrypted_request" };
	}

	async watchdog({ nowMs = this.now() } = {}) {
		if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("watchdog time must be a non-negative safe integer");
		const outcome = { noProgress: 0 };
		for (const job of this.store.listOperationalJobs({ nowMs })) {
			if (["completed", "failed", "cancelled", "recovery_review"].includes(job.lifecycle)) continue;
			if (!this.#noProgressIsDue(job, nowMs)) continue;
			const controller = this.controllers.get(job.jobId);
			if (controller?.signal.aborted) continue;
			try { this.store.recordEvent({ jobId: job.jobId, attemptId: job.attemptId ?? undefined, source: "helper", kind: "watchdog_intervened", safePayload: { watchdogReason: "no_progress" } }); } catch { continue; }
			if (controller) controller.abort("no_progress");
			else {
				try { this.store.recordEvent({ jobId: job.jobId, attemptId: job.attemptId ?? undefined, source: "helper", kind: "failed", safePayload: { reasonCode: "no_progress_timeout" } }); } catch {}
			}
			outcome.noProgress += 1;
		}
		return outcome;
	}

	async shutdown() {
		this.accepting = false;
		this.outboundClosed = true;
		for (const controller of this.outboundControllers) controller.abort("shutdown");
		for (const controller of this.controllers.values()) controller.abort("recovery");
		for (const item of this.queue.splice(0)) {
			try { this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } }); } catch {}
		}
		for (const finalizeMissed of [...this.pendingAcknowledgementFinalizers]) finalizeMissed();
		await this.waitForIdle();
		await Promise.allSettled([...this.pendingOutbound]);
	}

	// 파킹 알림은 봉인된 복구 봉투에 적힌 채널로만 보낸다. 그 값은 원래 요청이
	// 승인될 때 호스트가 직접 기록했고, #recoveryAuthority 가 같은 바인딩과
	// 참가자 권한이 아직 유효하다고 확인한 뒤에만 쓴다. 바인딩이 채널을 못박아
	// 두었다면 그 값과도 일치해야 한다.
	#recoveryNoticeChannel(binding, channelId) {
		if (!/^\d{17,20}$/.test(channelId ?? "") || /^0+$/.test(channelId)) return null;
		const bound = binding?.threadId ?? binding?.channelId ?? null;
		return bound === null || bound === channelId ? channelId : null;
	}

	resumeRecovered(items, { autoRetry = false } = {}) {
		if (items.length > 0 && !this.recoveryCodec) throw new Error("recovery codec is unavailable");
		for (const item of items) {
			let noticeChannelId = null;
			try {
				const payload = JSON.parse(this.recoveryCodec.open(item.envelope));
				const hasOriginalAccessCeiling = Object.hasOwn(payload, "originalAccessCeiling");
				const storedAccessCeiling = payload.accessCeiling ?? null;
				const originalAccessCeiling = hasOriginalAccessCeiling ? payload.originalAccessCeiling : storedAccessCeiling;
				if (originalAccessCeiling !== null && originalAccessCeiling !== "read-only") throw new Error("recovery access ceiling is invalid");
				if (payload.mode === "coordinator" || payload.mode === "coordinator_result") {
					throw new Error("coordinator recovery is withdrawn");
				}
				if (typeof payload.currentRequest !== "string" || !payload.currentRequest || payload.currentRequest.length > MAX_REQUEST_TEXT_LENGTH || !/^\d{17,20}$/.test(payload.channelId)) throw new Error("recovery payload is invalid");
				noticeChannelId = this.#recoveryNoticeChannelForPayload(payload);
				const authority = this.#recoveryAuthority(payload);
				const binding = authority.binding;
				const agentContext = this.#agentContext(binding);
				const requestedProfile = this.#executionProfile(item.backendId, authority, originalAccessCeiling);
				const currentWindow = mutationWindowStatus(authority?.participantProfile?.mutationWindow, this.now());
				const accessCeiling = storedAccessCeiling;
				const windowClosed = hasOriginalAccessCeiling
					&& originalAccessCeiling !== "read-only"
					&& requestedProfile.access !== "read-only"
					&& currentWindow.configured
					&& !currentWindow.allowed;
				const executionProfile = this.#executionProfile(item.backendId, authority, accessCeiling);
				const profileChanged = hasOriginalAccessCeiling
					? !sameExecutionProfileExceptAccess(payload.executionProfile, executionProfile)
					: !sameExecutionProfile(payload.executionProfile, executionProfile);
				if (this.config.schemaVersion === 2) {
					if (!autoRetry || profileChanged || executionProfile.access !== "read-only") throw new Error("automatic recovery is not allowed for this job");
				} else throw new Error("legacy recovery requires review");
				const prompt = boundRequestPrompt(payload.currentRequest, this.#profileConfig(binding), authority, agentContext.snapshot, accessCeiling, { windowClosed });
				const recovered = { jobId: item.jobId, backendId: item.backendId, prompt, currentRequest: payload.currentRequest, channelId: payload.channelId, scopeKey: typeof payload.scopeKey === "string" ? payload.scopeKey : null, participantUserId: payload.participantUserId, allowedUserIds: binding.allowedUserIds, authority, binding, agentContext, accessCeiling, ...(hasOriginalAccessCeiling ? { originalAccessCeiling } : {}), windowClosed, commandOptions: this.#withBackendOptions(item.backendId, commandOptionsForProfile(executionProfile)), executionProfile, policyPhase: "recovery" };
				if (!this.#operatorResponseFinalized(item.jobId)) this.#sendOperatorResponse(recovered);
				this.workItems.set(item.jobId, recovered);
				this.queue.push(recovered);
			} catch {
				this.store.recordEvent({ jobId: item.jobId, source: "recovery", kind: "recovery_review_required", safePayload: {} });
				// 파킹된 작업이 조용히 사라지면 요청자는 "[메시지 받음]" 뒤로 영원히
				// 기다린다. 작업 ID 와 재전송 안내만 한 번 보낸다. 원문은 싣지 않고,
				// 자동 재실행이나 상태 변경도 하지 않는다.
				if (noticeChannelId) void this.#sendControl({ token: this.token, channelId: noticeChannelId, botUserId: this.botUserId, content: `${RECOVERY_REVIEW_PARKED_NOTICE}\n작업 ID: ${item.jobId}`, nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise.catch(() => {});
			}
		}
		this.#drain();
	}
}
