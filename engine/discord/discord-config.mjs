import { constants as fsConstants, lstatSync, openSync, readFileSync, closeSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { assertOnlyKeys, safeIdentifier } from "./sanitize.mjs";
import { validateDiscordBindings } from "./discord-scope.mjs";
import { assertOwnerOnly } from "./platform-security.mjs";
import { validateCredentialProfiles } from "./credential-profiles.mjs";
import { grokDiscordCost } from "./grok-cost-profile.mjs";
import { normalizeMutationWindow } from "./mutation-window.mjs";

const ACTIONS = new Set(["read", "reply", "write", "execute", "cancel", "retry"]);
const RESERVED_PARTICIPANT_LABELS = new Set(["assistant", "developer", "system", "tool", "user"]);

function assertConversationActionContract(actions, label) {
	if (!actions.includes("read") || !actions.includes("reply")) throw new Error(`${label} must grant both read and reply`);
	if (actions.includes("write") !== actions.includes("execute")) throw new Error(`${label} must grant write and execute together`);
}

function snowflake(value, label) {
	if (typeof value !== "string" || !/^\d{17,20}$/.test(value) || /^0+$/.test(value)) throw new Error(`${label} must be a Discord snowflake`);
	return value;
}

function relativeConfigPath(value, label, { allowDot = false } = {}) {
	if (typeof value !== "string" || value.length < 1 || value.length > 512 || isAbsolute(value) || value.includes("\\") || (!allowDot && value === ".") || (value !== "." && value.split("/").some((part) => !part || part === "." || part === "..")) || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a safe relative path`);
	return value;
}

function workspaceConfigPath(value, label, { allowDot = false } = {}) {
	if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\\") || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a safe path`);
	if (isAbsolute(value)) return value;
	return relativeConfigPath(value, label, { allowDot });
}

function validateWorkspace(workspace) {
	assertOnlyKeys(workspace ?? {}, new Set(["path", "agentId", "entrypoint", "contextFiles", "allowedPaths"]), "workspace");
	workspaceConfigPath(workspace?.path, "workspace.path", { allowDot: true });
	safeIdentifier(workspace?.agentId, "workspace.agentId");
	relativeConfigPath(workspace?.entrypoint, "workspace.entrypoint");
	if (!Array.isArray(workspace?.contextFiles) || workspace.contextFiles.length === 0 || workspace.contextFiles.length > 15) throw new Error("workspace.contextFiles must contain between 1 and 15 entries");
	const contextFiles = workspace.contextFiles.map((value) => relativeConfigPath(value, "workspace.contextFiles entry"));
	if (new Set(contextFiles).size !== contextFiles.length) throw new Error("workspace.contextFiles must be unique");
	const allowedPaths = workspace.allowedPaths === undefined ? [workspace.path] : workspace.allowedPaths;
	if (!Array.isArray(allowedPaths) || allowedPaths.length < 1 || allowedPaths.length > 16) throw new Error("workspace.allowedPaths must contain between 1 and 16 entries");
	const normalizedAllowedPaths = [...new Set(allowedPaths.map((value) => workspaceConfigPath(value, "workspace.allowedPaths entry", { allowDot: true })))];
	if (!normalizedAllowedPaths.includes(workspace.path)) throw new Error("workspace.allowedPaths must include workspace.path");
	return { ...workspace, contextFiles, allowedPaths: normalizedAllowedPaths };
}

function validateAgentProfiles(profiles) {
	if (!profiles || typeof profiles !== "object" || Array.isArray(profiles) || Object.keys(profiles).length < 1 || Object.keys(profiles).length > 16) throw new Error("agentProfiles must be a non-empty profile map");
	const normalized = {};
	for (const [id, profile] of Object.entries(profiles)) {
		safeIdentifier(id, "agent profile ID");
		assertOnlyKeys(profile ?? {}, new Set(["workspace", "persona"]), "agent profile");
		assertOnlyKeys(profile?.persona ?? {}, new Set(["name", "instructions"]), "agent profile persona");
		if (typeof profile?.persona?.name !== "string" || !profile.persona.name || profile.persona.name.length > 80) throw new Error("agent profile persona name is invalid");
		if (typeof profile?.persona?.instructions !== "string" || !profile.persona.instructions || profile.persona.instructions.length > 4_000) throw new Error("agent profile persona instructions are invalid");
		normalized[id] = { workspace: validateWorkspace(profile.workspace), persona: { ...profile.persona } };
	}
	return normalized;
}

function validateParticipantProfiles(profiles, bindings, globalActions) {
	if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw new Error("discord.participantProfiles must be an exact user ID map");
	const expected = new Set(bindings.flatMap((binding) => binding.allowedUserIds));
	const actual = Object.keys(profiles);
	if (actual.length !== expected.size || actual.some((userId) => !expected.has(userId))) throw new Error("participantProfiles must exactly cover binding allowedUserIds");
	const labels = new Set();
	const normalized = {};
	for (const [userId, profile] of Object.entries(profiles)) {
		snowflake(userId, "participant profile user ID");
		assertOnlyKeys(profile ?? {}, new Set(["label", "relationship", "allowedActions", "mutationWindow"]), "participant profile");
		safeIdentifier(profile?.label, "participant label");
		const label = profile.label.toLowerCase();
		if (RESERVED_PARTICIPANT_LABELS.has(label)) throw new Error("participant label is reserved");
		if (labels.has(label)) throw new Error("participant labels must be unique");
		labels.add(label);
		if (typeof profile.relationship !== "string" || profile.relationship.length < 1 || profile.relationship.length > 160 || /[\0\r\n]/.test(profile.relationship)) throw new Error("participant relationship must be a short single line");
		if (!Array.isArray(profile.allowedActions) || profile.allowedActions.length === 0 || profile.allowedActions.some((action) => !ACTIONS.has(action))) throw new Error("participant profile contains unsupported allowed actions");
		const allowedActions = [...new Set(profile.allowedActions)].filter((action) => globalActions.includes(action));
		if (allowedActions.length === 0) throw new Error("participant effective actions must not be empty");
		assertConversationActionContract(allowedActions, "participant effective actions");
		const mutationWindow = normalizeMutationWindow(profile.mutationWindow);
		normalized[userId] = {
			label: profile.label,
			relationship: profile.relationship,
			allowedActions,
			...(mutationWindow === undefined ? {} : { mutationWindow }),
		};
	}
	return normalized;
}

function privateFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
	assertOwnerOnly(path, "file", label);
}

function privateDirectory(path, label) {
	const resolved = resolve(path);
	const root = parse(resolved).root;
	let cursor = root;
	for (const part of resolved.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
		cursor = resolve(cursor, part);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symbolic link`);
	}
	const stat = lstatSync(resolved);
	if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
	assertOwnerOnly(resolved, "directory", label);
}

function validateProjectPolicy(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("projectPolicy must be an object");
	assertOnlyKeys(value, new Set(["routeManifest", "bridgeScript", "timeoutMs"]), "projectPolicy");
	for (const [path, label] of [[value.routeManifest, "project policy route manifest"], [value.bridgeScript, "project policy bridge"]]) {
		if (typeof path !== "string" || path.length === 0 || path.length > 4_096 || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error(`${label} must be an absolute path`);
		privateFile(path, label);
	}
	if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60_000)) throw new Error("projectPolicy.timeoutMs must be between 1 and 60000");
	return value;
}

export function loadMessengerConfig(path) {
	const resolved = resolve(path);
	privateFile(resolved, "messenger config");
	const fd = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	let config;
	try { config = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
	assertOnlyKeys(config, new Set(["schemaVersion", "enabled", "workspaceId", "workspace", "agentProfiles", "persona", "role", "backend", "discord", "runtime", "observability", "service", "recovery", "projectPolicy"]), "messenger config");
	for (const [value, keys, label] of [
		[config.persona, ["name", "instructions"], "persona"],
		[config.role, ["name", "allowedActions", "requiresApproval"], "role"],
		[config.backend, ["selected", "profiles"], "backend"],
		[config.discord, ["credentialRef", "botUserId", "operatorUserIds", "bindings", "messageContentIntent", "participantProfiles", "proactiveDmRecipientUserId"], "discord"],
		[config.runtime ?? {}, ["softSilenceSeconds", "heartbeatSeconds", "maxConcurrentJobs", "approvalPolicy", "permissionProfileEpoch", "noProgressInterventionSeconds", "operatorResponseSeconds", "networkAccess", "credentialProfiles", "accessProfile"], "runtime"],
		[config.observability ?? {}, ["discordStatusProjection"], "observability"],
		[config.service ?? {}, ["autoStart", "startAt"], "service"],
		[config.recovery ?? {}, ["autoRetry"], "recovery"],
	]) assertOnlyKeys(value ?? {}, new Set(keys), label);
	if (config.projectPolicy !== undefined) validateProjectPolicy(config.projectPolicy);
	if (!new Set([1, 2]).has(config.schemaVersion)) throw new Error("unsupported messenger config schema");
	if (config.schemaVersion === 2) {
		if (config.agentProfiles !== undefined) {
			config.agentProfiles = validateAgentProfiles(config.agentProfiles);
			if (config.workspace !== undefined) throw new Error("workspace and agentProfiles are mutually exclusive");
		} else config.workspace = validateWorkspace(config.workspace);
	}
	else if (config.workspace !== undefined || config.discord?.participantProfiles !== undefined) throw new Error("workspace and participantProfiles require messenger config schema v2");
	if (config.enabled !== true) throw new Error("messenger service is disabled");
	if (!config.persona?.name || !config.persona?.instructions) throw new Error("persona name and instructions are required");
	if (config.persona.name.length > 80 || config.persona.instructions.length > 4_000) throw new Error("persona fields are too long");
	if (!config.role?.name || !Array.isArray(config.role.allowedActions)) throw new Error("role and allowedActions are required");
	if (config.role.allowedActions.length === 0 || config.role.allowedActions.some((value) => !ACTIONS.has(value))) throw new Error("role contains an unsupported allowed action");
	if (config.role.requiresApproval !== undefined && !Array.isArray(config.role.requiresApproval)) throw new Error("requiresApproval must be an array");
	if (config.role.requiresApproval?.some((value) => !ACTIONS.has(value))) throw new Error("role contains an unsupported approval action");
	if (!new Set(["codex", "claude", "opencode", "grok"]).has(config.backend?.selected)) throw new Error("selected backend is not supported");
	if (config.backend.profiles?.[config.backend.selected]?.enabled !== true) throw new Error("selected backend profile is disabled");
	for (const [name, profile] of Object.entries(config.backend.profiles ?? {})) {
		if (!new Set(["codex", "claude", "opencode", "grok"]).has(name)) throw new Error("unsupported backend profile");
		assertOnlyKeys(profile, new Set(["enabled", "model", "costProfile", "reasoningEffort"]), "backend profile");
		if (typeof profile.enabled !== "boolean") throw new Error("backend profile enabled must be boolean");
		if (profile.model !== undefined && (typeof profile.model !== "string" || !/^(?=.{1,80}$)[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/.test(profile.model))) throw new Error("backend profile model is invalid");
		if (profile.costProfile !== undefined && ((name !== "codex" && name !== "grok") || !new Set(["control", "balanced", "economy"]).has(profile.costProfile))) throw new Error("backend profile costProfile is invalid");
		if (profile.reasoningEffort !== undefined && ((name !== "codex" && name !== "grok") || !new Set(["low", "medium", "high", "max"]).has(profile.reasoningEffort))) throw new Error("backend profile reasoningEffort is invalid");
		if (name === "codex" && profile.costProfile === undefined) profile.costProfile = "balanced";
		if (name === "grok" && profile.costProfile === undefined) profile.costProfile = "balanced";
		if (name === "grok" && profile.model === undefined) profile.model = "grok-4.6";
		if (name === "grok" && profile.reasoningEffort === undefined) profile.reasoningEffort = grokDiscordCost(profile.costProfile).reasoningEffort;
	}
	safeIdentifier(config.discord?.credentialRef, "credentialRef");
	snowflake(config.discord?.botUserId, "Discord bot user ID");
	if (config.discord.operatorUserIds !== undefined && !Array.isArray(config.discord.operatorUserIds)) throw new Error("operatorUserIds must be an array");
	config.discord.operatorUserIds = [...new Set(config.discord.operatorUserIds ?? [])];
	config.discord.operatorUserIds.forEach((value) => snowflake(value, "operator Discord ID"));
	if (config.discord.messageContentIntent !== undefined && typeof config.discord.messageContentIntent !== "boolean") throw new Error("messageContentIntent must be boolean");
	// 모델이 스스로 보내겠다고 한 DM 이 실제로 갈 수 있는 단 한 사람. 설정하지
	// 않으면 그 기능은 꺼진 채로 둔다 — 기본 수신자를 코드에 박아 두면 그 저장소를
	// 받은 모든 사람의 봇이 남의 계정으로 DM 을 보내려 든다.
	if (config.discord.proactiveDmRecipientUserId !== undefined) {
		snowflake(config.discord.proactiveDmRecipientUserId, "proactive DM recipient Discord ID");
		if (!config.discord.operatorUserIds.includes(config.discord.proactiveDmRecipientUserId)) {
			throw new Error("proactive DM recipient must be one of the configured operators");
		}
	}
	config.discord.bindings = validateDiscordBindings(config.discord.bindings, { messageContentIntent: config.discord.messageContentIntent === true, schemaVersion: config.schemaVersion });
	if (config.agentProfiles) {
		for (const binding of config.discord.bindings) if (!config.agentProfiles[binding.agentProfileId]) throw new Error("Discord binding references an unknown agent profile");
	} else if (config.discord.bindings.some((binding) => binding.agentProfileId !== undefined)) throw new Error("binding agentProfileId requires agentProfiles");
	const globalActions = config.role.allowedActions.filter((action) => !(config.role.requiresApproval ?? []).includes(action));
	if (config.schemaVersion === 2) {
		assertConversationActionContract(globalActions, "schema v2 role actions");
		config.discord.participantProfiles = validateParticipantProfiles(config.discord.participantProfiles, config.discord.bindings, globalActions);
		const untrustedParticipant = Object.keys(config.discord.participantProfiles).find((userId) => !config.discord.operatorUserIds.includes(userId));
		if (untrustedParticipant) throw new Error("schema v2 Discord participants must be trusted host operators");
	} else {
		const allowedUsers = new Set(config.discord.bindings.flatMap((binding) => binding.allowedUserIds));
		if (allowedUsers.size > 1) config.discord.bindings = config.discord.bindings.map((binding) => ({ ...binding, historyVisibility: "none" }));
		const mutationEnabled = globalActions.some((action) => action === "write" || action === "execute");
		const mutationUsers = new Set(config.discord.bindings.filter((binding) => mutationEnabled && binding.canStartConversation && binding.operatorActions === true).flatMap((binding) => binding.allowedUserIds));
		if (mutationUsers.size >= 2) throw new Error("schema v1 cannot grant mutation in a multi-user binding");
	}
	const maxConcurrent = config.runtime?.maxConcurrentJobs ?? 1;
	if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error("maxConcurrentJobs must be between 1 and 8");
	const heartbeatSeconds = config.runtime?.heartbeatSeconds ?? 10;
	const softSilenceSeconds = config.runtime?.softSilenceSeconds ?? 120;
	if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 1 || heartbeatSeconds > 60) throw new Error("heartbeatSeconds must be between 1 and 60");
	if (!Number.isSafeInteger(softSilenceSeconds) || softSilenceSeconds < 1 || softSilenceSeconds > 3_600) throw new Error("softSilenceSeconds must be between 1 and 3600");
	if (config.runtime?.approvalPolicy !== "never") throw new Error("runtime.approvalPolicy must be explicitly set to never for unattended messenger work");
	config.runtime.accessProfile = config.runtime?.accessProfile ?? "controlled";
	if (!new Set(["controlled", "trusted-local"]).has(config.runtime.accessProfile)) throw new Error("runtime.accessProfile must be controlled or trusted-local");
	if (config.runtime.accessProfile === "trusted-local") {
		if (config.schemaVersion !== 2) throw new Error("trusted-local requires messenger config schema v2");
		if (config.discord.operatorUserIds.length !== 1 || Object.keys(config.discord.participantProfiles).length !== 1) throw new Error("trusted-local requires exactly one operator participant");
		const [operatorUserId] = config.discord.operatorUserIds;
		if (!config.discord.participantProfiles[operatorUserId]) throw new Error("trusted-local participant must be the exact operator");
		if (!globalActions.includes("write") || !globalActions.includes("execute")) throw new Error("trusted-local requires write and execute role actions");
		if (config.discord.bindings.some((binding) => binding.kind !== "dm" || binding.allowedUserIds.length !== 1 || binding.allowedUserIds[0] !== operatorUserId || binding.canStartConversation !== true || binding.operatorActions !== true)) throw new Error("trusted-local requires DM-only operator bindings");
		const participantActions = config.discord.participantProfiles[operatorUserId].allowedActions;
		if (!participantActions.includes("write") || !participantActions.includes("execute")) throw new Error("trusted-local operator requires write and execute participant actions");
	}
	if (config.runtime?.permissionProfileEpoch !== undefined) safeIdentifier(config.runtime.permissionProfileEpoch, "permissionProfileEpoch");
	if (config.runtime?.networkAccess !== undefined && typeof config.runtime.networkAccess !== "boolean") throw new Error("runtime.networkAccess must be boolean");
	config.runtime.credentialProfiles = validateCredentialProfiles(config.runtime?.credentialProfiles, "runtime.credentialProfiles");
	if ((config.runtime?.credentialProfiles?.length ?? 0) > 0 && config.runtime?.networkAccess !== true) throw new Error("runtime credential profiles require networkAccess");
	const noProgressInterventionSeconds = config.runtime?.noProgressInterventionSeconds ?? softSilenceSeconds;
	const operatorResponseSeconds = config.runtime?.operatorResponseSeconds ?? 30;
	if (!Number.isSafeInteger(noProgressInterventionSeconds) || noProgressInterventionSeconds < softSilenceSeconds || noProgressInterventionSeconds > 3_600) throw new Error("noProgressInterventionSeconds must be between softSilenceSeconds and 3600");
	if (!Number.isSafeInteger(operatorResponseSeconds) || operatorResponseSeconds < 1 || operatorResponseSeconds > 3_600) throw new Error("operatorResponseSeconds must be between 1 and 3600");
	if (config.recovery?.autoRetry !== undefined && typeof config.recovery.autoRetry !== "boolean") throw new Error("recovery autoRetry must be boolean");
	if (!new Set(["login", "boot"]).has(config.service?.startAt ?? "login")) throw new Error("service startAt must be login or boot");
	if (config.service?.autoStart !== undefined && typeof config.service.autoStart !== "boolean") throw new Error("service autoStart must be boolean");
	if (config.observability?.discordStatusProjection !== undefined && typeof config.observability.discordStatusProjection !== "boolean") throw new Error("discordStatusProjection must be boolean");
	return config;
}

export class FileCredentialResolver {
	constructor(credentialsDirectory) { this.credentialsDirectory = resolve(credentialsDirectory); }
	resolve(reference) {
		safeIdentifier(reference, "credentialRef");
		privateDirectory(this.credentialsDirectory, "credentials directory");
		const path = resolve(this.credentialsDirectory, reference);
		const relativePath = relative(this.credentialsDirectory, path);
		if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("credential path escaped its directory");
		privateFile(path, "Discord credential");
		const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			const value = readFileSync(fd, "utf8").trim();
			if (value.length < 16) throw new Error("Discord credential is empty or invalid");
			return value;
		} finally { closeSync(fd); }
	}
}
