import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadMessengerConfig, FileCredentialResolver } from "./discord-config.mjs";
import { DiscordGatewaySession, StoredGatewayState } from "./discord-gateway.mjs";
import { DiscordMessageRouter } from "./discord-router.mjs";
import { SessionStore } from "./store.mjs";
import { loadOrCreateRecoveryKey, RecoveryCodec } from "./recovery-crypto.mjs";
import { DiscordStatusProjection } from "./discord-projection.mjs";
import { discordScopeKey } from "./discord-scope.mjs";
import { postDiscordMessage } from "./discord-delivery.mjs";
import { messengerInstancePaths } from "./instance-paths.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";
import { fetchDiscordConversation } from "./discord-conversation.mjs";
import { buildAgentContextSnapshot } from "./agent-context.mjs";
import { acquireDiscordTokenOwnerLock, defaultDiscordTokenLockDirectory, discordTokenFingerprint } from "./token-owner-lock.mjs";
import { DISCORD_SERVICE_FAILURE_REASONS } from "./constants.mjs";
import { createConfiguredProjectPolicy, projectPolicyRuntimeRevision } from "./project-policy-dispatcher.mjs";

export function configuredBackendCommand(name) {
	const executable = process.env[`NAIA_${name.toUpperCase()}_EXECUTABLE`];
	if (!executable) return null;
	const encoded = process.env[`NAIA_${name.toUpperCase()}_PREFIX_ARGS`];
	if (!encoded) return executable;
	let prefixArgs;
	try { prefixArgs = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
	catch { throw new Error(`${name} backend prefix arguments are invalid`); }
	if (!Array.isArray(prefixArgs) || prefixArgs.length !== 1 || prefixArgs.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new Error(`${name} backend prefix arguments are invalid`);
	}
	return { command: executable, prefixArgs };
}

export function isSqliteBusyError(error) {
	return error?.errcode === 5 || error?.code === "SQLITE_BUSY" || (error?.code === "ERR_SQLITE_ERROR" && /database (?:is )?locked/i.test(error?.message ?? ""));
}

export function heartbeatServiceSafely(store, input, { onBusy = () => console.error("naia-discord-service: heartbeat_sqlite_busy_skipped") } = {}) {
	try {
		store.heartbeatService(input);
		return true;
	} catch (error) {
		if (!isSqliteBusyError(error)) throw error;
		onBusy();
		return false;
	}
}

export async function handleJobControlRequest(router, request, generation) {
	const actions = new Set(["cancel", "restart", "amend", "submit"]);
	const jobIdIsValid = request?.action === "submit" || typeof request?.jobId === "string";
	if (request?.schemaVersion !== 1 || request.generation !== generation || !actions.has(request.action) || typeof request.requestId !== "string" || !jobIdIsValid) {
		return { schemaVersion: 1, requestId: typeof request?.requestId === "string" ? request.requestId : null, generation, state: "rejected", action: "unknown", reasonCode: "invalid_control_request" };
	}
	const result = request.action === "submit"
		? await router.submitOperatorRequest({ channelId: request.channelId, authorId: request.authorId, content: request.content, access: request.access ?? null })
		: request.action === "cancel"
			? router.cancelJob(request.jobId)
			: router.replaceJob(request.jobId, { action: request.action, amendment: request.amendment });
	return { schemaVersion: 1, requestId: request.requestId, generation, ...result };
}

export async function cleanupDiscordServiceResources({ heartbeatTimer = null, watchdogTimer = null, controlTimer = null, gateway = null, router = null, store = null, tokenOwnerLock, generation }) {
	let firstError = null;
	const capture = async (action) => {
		try { await action(); }
		catch (error) { firstError ??= error; }
	};
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	if (watchdogTimer) clearInterval(watchdogTimer);
	if (controlTimer) clearInterval(controlTimer);
	await capture(async () => router?.shutdown());
	await capture(async () => gateway?.drain());
	if (store) {
		await capture(async () => heartbeatServiceSafely(store, { generation, status: "stopped", pid: null }));
		await capture(async () => store.close());
	}
	await capture(async () => tokenOwnerLock?.release());
	if (firstError) throw firstError;
}

export function configuredAgentContext(root, config) {
	if (config.schemaVersion !== 2) return { cwd: root, allowedPaths: [realpathSync(root)], snapshot: null };
	const canonicalRoot = realpathSync(root);
	const candidate = isAbsolute(config.workspace.path) ? config.workspace.path : resolve(canonicalRoot, config.workspace.path);
	const candidateRelative = relative(canonicalRoot, candidate);
	if (candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) throw new Error("configured workspace escaped the ADK root");
	const snapshot = buildAgentContextSnapshot({ workspace: candidate, agentId: config.workspace.agentId, entrypoint: config.workspace.entrypoint, contextFiles: config.workspace.contextFiles });
	const resolvedRelative = relative(canonicalRoot, snapshot.workspaceRoot);
	if (resolvedRelative.startsWith("..") || isAbsolute(resolvedRelative)) throw new Error("configured workspace escaped the ADK root");
	const allowedPaths = config.workspace.allowedPaths.map((path) => {
		const allowed = realpathSync(isAbsolute(path) ? path : resolve(canonicalRoot, path));
		const allowedRelative = relative(canonicalRoot, allowed);
		if (allowedRelative.startsWith("..") || isAbsolute(allowedRelative)) throw new Error("configured allowed workspace escaped the ADK root");
		return allowed;
	});
	if (!allowedPaths.includes(snapshot.workspaceRoot)) throw new Error("configured workspace is missing from resolved allowed paths");
	return { cwd: snapshot.workspaceRoot, allowedPaths: [...new Set(allowedPaths)], snapshot };
}

function configuredAgentContextForId(root, config, id = "default") {
	if (!config.agentProfiles) {
		if (id !== "default") throw new Error("unknown agent profile");
		return configuredAgentContext(root, config);
	}
	const profile = config.agentProfiles[id];
	if (!profile) throw new Error("unknown agent profile");
	return configuredAgentContext(root, { ...config, agentProfiles: undefined, workspace: profile.workspace });
}

export function configuredAgentContexts(root, config) {
	if (!config.agentProfiles) return { default: configuredAgentContext(root, config) };
	return Object.fromEntries(Object.keys(config.agentProfiles).map((id) => [id, configuredAgentContextForId(root, config, id)]));
}

function runtimeDigest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function globalConfigProjection(config) {
	if (!config || typeof config !== "object" || Array.isArray(config)) return config;
	const projected = { ...config };
	// Workspace files and their resolved paths are checked by the selected
	// context digest. Keeping them out of this digest lets a multi-agent router
	// reject only the participant whose context changed.
	delete projected.workspace;
	if (projected.agentProfiles && typeof projected.agentProfiles === "object" && !Array.isArray(projected.agentProfiles)) {
		projected.agentProfiles = Object.fromEntries(Object.entries(projected.agentProfiles).map(([id, profile]) => {
			if (!profile || typeof profile !== "object" || Array.isArray(profile)) return [id, profile];
			const profileProjection = { ...profile };
			delete profileProjection.workspace;
			return [id, profileProjection];
		}));
	}
	return projected;
}

function globalRuntimeRevision({ config, token }) {
	return runtimeDigest({ config: globalConfigProjection(config), tokenFingerprint: discordTokenFingerprint(token) });
}

function contextRuntimeRevision(agentContext) {
	return runtimeDigest({
		agentId: agentContext?.snapshot?.agentId ?? null,
		workspaceRoot: agentContext?.cwd ?? null,
		allowedPaths: agentContext?.allowedPaths ?? (agentContext?.cwd ? [agentContext.cwd] : []),
		contextHash: agentContext?.snapshot?.contextHash ?? null,
	});
}

export function runtimeInputsRevision({ config, token, agentContext, agentContexts, projectPolicy = null }) {
	agentContexts ??= { default: agentContext };
	return runtimeDigest({
		globalRevision: globalRuntimeRevision({ config, token }),
		agentContexts: Object.fromEntries(Object.entries(agentContexts).sort(([left], [right]) => left.localeCompare(right)).map(([id, context]) => [id, contextRuntimeRevision(context)])),
		projectPolicyRevision: projectPolicyRuntimeRevision(projectPolicy),
	});
}

function runtimeInputsChangedError() {
	const error = new Error("Discord runtime inputs changed; restart is required");
	error.code = "context_changed_restart_required";
	return error;
}

export function createRuntimeInputVerifier({ root, paths, config, token, agentContext, agentContexts, projectPolicy = null }) {
	agentContexts ??= { default: agentContext };
	const baselineGlobalRevision = globalRuntimeRevision({ config, token });
	const baselineContextRevisions = new Map(Object.entries(agentContexts).map(([id, context]) => [id, contextRuntimeRevision(context)]));
	const baselinePolicyRevision = projectPolicyRuntimeRevision(projectPolicy);
	const baselineRevision = runtimeInputsRevision({ config, token, agentContexts, projectPolicy });
	let globalInvalidated = false;
	const invalidatedContexts = new Set();
	return ({ agentContextId = "default", agentContext: selectedContext = null } = {}) => {
		const id = agentContextId || "default";
		if (globalInvalidated || invalidatedContexts.has(id)) throw runtimeInputsChangedError();
		const baselineContextRevision = baselineContextRevisions.get(id);
		if (!baselineContextRevision) {
			invalidatedContexts.add(id);
			throw runtimeInputsChangedError();
		}
		let currentConfig;
		let currentToken;
		try {
			currentConfig = loadMessengerConfig(paths.configPath);
			currentToken = new FileCredentialResolver(paths.credentialsDirectory).resolve(currentConfig.discord.credentialRef);
		} catch {
			globalInvalidated = true;
			throw runtimeInputsChangedError();
		}
		if (globalRuntimeRevision({ config: currentConfig, token: currentToken }) !== baselineGlobalRevision) {
			globalInvalidated = true;
			throw runtimeInputsChangedError();
		}
		let currentAgentContext;
		try {
			currentAgentContext = configuredAgentContextForId(root, currentConfig, id);
		} catch {
			invalidatedContexts.add(id);
			throw runtimeInputsChangedError();
		}
		if (contextRuntimeRevision(currentAgentContext) !== baselineContextRevision || (selectedContext && contextRuntimeRevision(selectedContext) !== baselineContextRevision)) {
			invalidatedContexts.add(id);
			throw runtimeInputsChangedError();
		}
		try {
			if (projectPolicyRuntimeRevision(projectPolicy) !== baselinePolicyRevision) {
				invalidatedContexts.add(id);
				throw runtimeInputsChangedError();
			}
		} catch (error) {
			invalidatedContexts.add(id);
			if (error?.code === "context_changed_restart_required") throw error;
			throw runtimeInputsChangedError();
		}
		return baselineRevision;
	};
}

function startupFailure(reasonCode) {
	const error = new Error(reasonCode);
	error.serviceReasonCode = reasonCode;
	return error;
}

export function classifyDiscordServiceFailure(error) {
	if (error?.code === "DISCORD_TOKEN_ALREADY_OWNED") return "discord_token_already_owned";
	if (error?.code === "DISCORD_TOKEN_LOCK_UNAVAILABLE") return "discord_token_lock_unavailable";
	if (error?.code === "context_changed_restart_required") return "context_changed_restart_required";
	if (new Set(["configuration_invalid", "context_invalid", "credential_unavailable"]).has(error?.serviceReasonCode)) return error.serviceReasonCode;
	return "startup_or_runtime_failure";
}

export function writeDiscordServiceFailure(paths, reasonCode) {
	if (!DISCORD_SERVICE_FAILURE_REASONS.has(reasonCode)) throw new Error("unsupported Discord service failure reason");
	mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
	protectOwnerOnly(paths.stateDirectory, "directory", "Discord service state");
	const temporary = `${paths.serviceFailurePath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, reasonCode, observedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
	protectOwnerOnly(temporary, "file", "Discord service failure state");
	renameSync(temporary, paths.serviceFailurePath);
	protectOwnerOnly(paths.serviceFailurePath, "file", "Discord service failure state");
}

export async function runDiscordService({ adkRoot, instance = "default", managedRuntimeRevision = null, webSocketFactory, fetchImpl, sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)), signalSource = process, tokenLockDirectory = defaultDiscordTokenLockDirectory(), projectPolicy = undefined } = {}) {
	const root = resolve(adkRoot);
	const paths = messengerInstancePaths(root, instance);
	if (managedRuntimeRevision !== null && !/^[a-f0-9]{40}$/.test(managedRuntimeRevision)) throw startupFailure("startup_or_runtime_failure");
	let config;
	try { config = loadMessengerConfig(paths.configPath); }
	catch { throw startupFailure("configuration_invalid"); }
	let agentContexts;
	try { agentContexts = configuredAgentContexts(root, config); }
	catch { throw startupFailure("context_invalid"); }
	let token;
	try { token = new FileCredentialResolver(paths.credentialsDirectory).resolve(config.discord.credentialRef); }
	catch { throw startupFailure("credential_unavailable"); }
	let effectiveProjectPolicy;
	try {
		effectiveProjectPolicy = projectPolicy === undefined ? createConfiguredProjectPolicy({ config, root }) : projectPolicy;
	} catch {
		throw startupFailure("configuration_invalid");
	}
	const verifyRuntimeInputs = createRuntimeInputVerifier({ root, paths, config, token, agentContexts, projectPolicy: effectiveProjectPolicy });
	const kernelTokenFingerprint = process.env.NAIA_DISCORD_KERNEL_TOKEN_FINGERPRINT;
	if (kernelTokenFingerprint !== undefined && kernelTokenFingerprint !== discordTokenFingerprint(token)) throw startupFailure("discord_token_lock_unavailable");
	// The environment marker proves only that the unit used the expected token;
	// it never grants permission to skip shared ownership. Managed Linux adds an
	// outer kernel flock and still acquires this cross-launch owner record.
	const tokenOwnerLock = acquireDiscordTokenOwnerLock({ token, lockDirectory: tokenLockDirectory });
	let store = null;
	let router = null;
	let projection = null;
	let heartbeatTimer = null;
	let watchdogTimer = null;
	let controlTimer = null;
	let controlBusy = false;
	const generation = managedRuntimeRevision === null ? randomUUID() : `${managedRuntimeRevision}.${randomUUID().slice(0, 8)}`;
	let stopping = false;
	let gateway = null;
	let wakeReconnect = null;
	let wakeStop = null;
	try {
		store = new SessionStore(paths.databasePath);
		const recoveryCodec = new RecoveryCodec(loadOrCreateRecoveryKey(paths.recoveryKeyPath));
		projection = config.observability?.discordStatusProjection === true ? new DiscordStatusProjection({ store, token, botUserId: config.discord.botUserId, fetchImpl }) : null;
		const stopRequested = new Promise((resolveStop) => { wakeStop = resolveStop; });
		const delivery = fetchImpl ? (input) => import("./discord-delivery.mjs").then(({ deliverJobResult }) => deliverJobResult({ ...input, fetchImpl })) : undefined;
		const backendExecutables = {
			...(configuredBackendCommand("codex") ? { codex: configuredBackendCommand("codex") } : {}),
			...(configuredBackendCommand("claude") ? { claude: configuredBackendCommand("claude") } : {}),
			...(configuredBackendCommand("opencode") ? { opencode: configuredBackendCommand("opencode") } : {}),
			...(configuredBackendCommand("grok") ? { grok: configuredBackendCommand("grok") } : {}),
		};
		const send = fetchImpl ? (input) => postDiscordMessage({ ...input, fetchImpl }) : postDiscordMessage;
		const loadHistory = (input) => fetchDiscordConversation({ ...input, fetchImpl: fetchImpl ?? fetch });
		const defaultContext = agentContexts.default ?? Object.values(agentContexts)[0];
		router = new DiscordMessageRouter({ config, store, token, botUserId: config.discord.botUserId, cwd: defaultContext.cwd, allowedPaths: defaultContext.allowedPaths, agentContexts, runtimeRoot: paths.runtimeRoot, instance: paths.instance, agentContextSnapshot: defaultContext.snapshot, runtimeRevision: managedRuntimeRevision ?? null, recoveryCodec, projectStatus: projection ? (input) => projection.publishScope(input) : null, ...(effectiveProjectPolicy === null ? {} : { projectPolicy: effectiveProjectPolicy }), deliver: delivery, send, loadHistory, backendExecutables, verifyRuntimeInputs });
		let reconnectDelay = 1_000;
		const heartbeat = () => heartbeatServiceSafely(store, { generation, status: stopping ? "stopped" : "running", pid: stopping ? null : process.pid });
		heartbeat();
		try { unlinkSync(paths.serviceFailurePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
		const recoveredJobs = store.recoverInterruptedWork();
		router.resumeRecovered(recoveredJobs, { autoRetry: config.recovery?.autoRetry === true });
		if (projection) {
			for (const binding of config.discord.bindings.filter((item) => item.operatorActions === true)) {
				const channelId = binding.threadId ?? binding.channelId;
				if (!channelId) continue;
				const scopeKey = discordScopeKey({ kind: binding.kind, guildId: binding.guildId, channelId: binding.channelId, threadId: binding.threadId });
					void router.projectScope({ scopeKey, channelId }).catch(() => {});
			}
		}
		heartbeatTimer = setInterval(heartbeat, (config.runtime?.heartbeatSeconds ?? 10) * 1_000);
		const watchdogIntervalSeconds = Math.max(1, Math.min(config.runtime?.heartbeatSeconds ?? 10, config.runtime?.noProgressInterventionSeconds ?? config.runtime?.softSilenceSeconds ?? 120));
		watchdogTimer = setInterval(() => { void router.watchdog().catch(() => {}); }, watchdogIntervalSeconds * 1_000);
		watchdogTimer.unref?.();
		const stop = () => { stopping = true; gateway?.close(1_000); wakeReconnect?.(); wakeStop?.({ resumable: false }); };
		controlTimer = setInterval(async () => {
			if (controlBusy) return;
			controlBusy = true;
			try {
			if (existsSync(paths.jobControlRequestPath)) {
				let receipt = null;
				try {
					assertOwnerOnly(paths.jobControlRequestPath, "file", "Discord job control request");
					const request = JSON.parse(readFileSync(paths.jobControlRequestPath, "utf8"));
					receipt = { ...await handleJobControlRequest(router, request, generation), observedAt: new Date().toISOString() };
				} catch { receipt = { schemaVersion: 1, state: "rejected", action: "unknown", reasonCode: "invalid_control_request", observedAt: new Date().toISOString() }; }
				try { unlinkSync(paths.jobControlRequestPath); } catch {}
				try {
					const temporary = `${paths.jobControlReceiptPath}.${process.pid}.${randomUUID()}.tmp`;
					writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
					protectOwnerOnly(temporary, "file", "Discord job control receipt");
					renameSync(temporary, paths.jobControlReceiptPath);
					protectOwnerOnly(paths.jobControlReceiptPath, "file", "Discord job control receipt");
				} catch {}
			}
			if (!existsSync(paths.stopRequestPath)) return;
			try {
				assertOwnerOnly(paths.stopRequestPath, "file", "Discord stop request");
				const request = JSON.parse(readFileSync(paths.stopRequestPath, "utf8"));
				if (request?.schemaVersion === 1 && request.generation === generation) {
					unlinkSync(paths.stopRequestPath);
					stop();
				}
			} catch {}
			} finally {
				controlBusy = false;
			}
		}, 250);
		signalSource.once?.("SIGTERM", stop);
		signalSource.once?.("SIGINT", stop);
		while (!stopping) {
			let disconnected;
			const closed = new Promise((resolveClosed) => { disconnected = resolveClosed; });
			gateway = new DiscordGatewaySession({
				token,
				expectedBotUserId: config.discord.botUserId,
				stateRepository: new StoredGatewayState(store),
				webSocketFactory,
				messageContentIntent: config.discord.messageContentIntent === true,
				onDisconnect: disconnected,
				onDispatch: (type, data, sequence) => { if (type === "READY" || type === "RESUMED") reconnectDelay = 1_000; return router.onDispatch(type, data, sequence); },
			});
			gateway.connect();
			const event = await Promise.race([closed, stopRequested]);
			if (stopping) break;
			if (event.resumable === false) { stopping = true; break; }
			await Promise.race([sleep(reconnectDelay), new Promise((resolveWake) => { wakeReconnect = resolveWake; })]);
			wakeReconnect = null;
			reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
		}
	} finally {
		stopping = true;
		await cleanupDiscordServiceResources({ heartbeatTimer, watchdogTimer, controlTimer, gateway, router, store, tokenOwnerLock, generation });
	}
}
