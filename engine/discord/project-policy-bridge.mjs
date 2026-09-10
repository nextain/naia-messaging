import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const ROUTE_VERSION = 1;
const PHASES = new Set(["accept", "enqueue", "pre_spawn", "retry", "recovery"]);
const BACKENDS = new Set(["claude", "codex", "grok", "opencode"]);
const ACCESS_LEVELS = new Set(["read-only", "workspace-write", "danger-full-access"]);
const PUBLIC_REASONS = new Set([
	"project_policy_route_unavailable",
	"project_policy_window_closed",
	"project_policy_participant_rejected",
	"project_policy_workspace_mismatch",
	"project_policy_authority_changed",
	"project_policy_contract_invalid",
	"project_policy_rejected",
]);

function safeError(code) {
	const error = new Error(code);
	error.code = code;
	error.projectPolicy = true;
	return error;
}

function isSafeSnowflake(value) {
	return /^\d{17,20}$/.test(value ?? "") && !/^0+$/.test(value);
}

function boundedString(value, maximum = 4_096) {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function assertAbsolute(value, label) {
	if (!boundedString(value) || !isAbsolute(value)) throw safeError("project_policy_participant_rejected");
	return value;
}

function assertInput(input) {
	if (!input || typeof input !== "object" || Array.isArray(input) || input.schemaVersion !== ROUTE_VERSION) throw safeError("project_policy_participant_rejected");
	if (!isSafeSnowflake(input.participantUserId)) throw safeError("project_policy_participant_rejected");
	if (!boundedString(input.bindingIdentity, 512)) throw safeError("project_policy_participant_rejected");
	if (!BACKENDS.has(input.backendId) || !ACCESS_LEVELS.has(input.access) || !PHASES.has(input.phase)) throw safeError("project_policy_participant_rejected");
	if (input.access === "read-only") throw safeError("project_policy_participant_rejected");
	if (input.jobId !== null && input.jobId !== undefined && !boundedString(input.jobId, 128)) throw safeError("project_policy_participant_rejected");
	if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw safeError("project_policy_participant_rejected");
	if (!input.participantProfile || typeof input.participantProfile !== "object" || Array.isArray(input.participantProfile)) throw safeError("project_policy_participant_rejected");
	if (input.participantProfile.discordUserId !== input.participantUserId) throw safeError("project_policy_authority_changed");
	assertAbsolute(input.cwd, "cwd");
	if (!Array.isArray(input.allowedPaths) || input.allowedPaths.length === 0 || input.allowedPaths.length > 32) throw safeError("project_policy_participant_rejected");
	const allowedPaths = input.allowedPaths.map((value) => assertAbsolute(value, "allowedPaths"));
	if (!allowedPaths.includes(input.cwd)) throw safeError("project_policy_workspace_mismatch");
	return { ...input, allowedPaths: [...new Set(allowedPaths)] };
}

function validateResult(result, input) {
	if (!result || typeof result !== "object" || Array.isArray(result) || result.schemaVersion !== ROUTE_VERSION || typeof result.allowed !== "boolean") {
		throw safeError("project_policy_rejected");
	}
	if (!result.allowed) {
		const reasonCode = PUBLIC_REASONS.has(result.reasonCode) ? result.reasonCode : "project_policy_rejected";
		throw safeError(reasonCode);
	}
	// The current router passes its verified execution profile and path set to
	// the runner before the final pre-spawn callback.  Until that runner seam
	// carries a policy result through every retry/recovery path, accepting a
	// narrower result here would authorize one envelope while executing the
	// original broader profile.  Fail closed on any access/path change so the
	// bridge and router share one exact result contract.
	if (!ACCESS_LEVELS.has(result.access) || result.access !== input.access) throw safeError("project_policy_contract_invalid");
	if (result.cwd !== input.cwd || !Array.isArray(result.allowedPaths) || result.allowedPaths.length !== input.allowedPaths.length || result.allowedPaths.some((value, index) => value !== input.allowedPaths[index])) throw safeError("project_policy_workspace_mismatch");
	if (result.participantUserId !== input.participantUserId || result.bindingIdentity !== input.bindingIdentity) throw safeError("project_policy_authority_changed");
	if (result.reasonCode !== null && result.reasonCode !== undefined) throw safeError("project_policy_contract_invalid");
	return Object.freeze({
		schemaVersion: ROUTE_VERSION,
		allowed: true,
		access: result.access,
		cwd: result.cwd,
		allowedPaths: [...result.allowedPaths],
		participantUserId: result.participantUserId,
		bindingIdentity: result.bindingIdentity,
		reasonCode: null,
	});
}

export function isProjectPolicyReason(code) {
	return PUBLIC_REASONS.has(code) && code !== "project_policy_route_unavailable";
}

export function projectPolicyError(code = "project_policy_rejected") {
	return safeError(isProjectPolicyReason(code) || code === "project_policy_route_unavailable" ? code : "project_policy_rejected");
}

/**
 * Synchronous host adapter for the project-owned native policy validator.
 * The host supplies the authenticated Discord binding and the real child
 * cwd. The native process returns only a bounded allow/deny envelope.
 */
export class ProjectPolicyBridge {
	constructor({ routeFile, bridgeScript, participantProfile = {}, nodePath = process.execPath, timeoutMs = 5_000, spawnSyncImpl = spawnSync } = {}) {
		if (!boundedString(routeFile) || !isAbsolute(routeFile) || !boundedString(bridgeScript) || !isAbsolute(bridgeScript)) throw projectPolicyError("project_policy_route_unavailable");
		if (!boundedString(nodePath) || !isAbsolute(nodePath) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || typeof spawnSyncImpl !== "function") throw projectPolicyError("project_policy_route_unavailable");
		if (!participantProfile || typeof participantProfile !== "object" || Array.isArray(participantProfile)) throw projectPolicyError("project_policy_route_unavailable");
		this.routeFile = routeFile;
		this.bridgeScript = bridgeScript;
		this.participantProfile = Object.freeze({ ...participantProfile });
		this.nodePath = nodePath;
		this.timeoutMs = timeoutMs;
		this.spawnSyncImpl = spawnSyncImpl;
	}

	check(input) {
		const checkedInput = assertInput(input);
		const payload = {
			...checkedInput,
			participantProfile: {
				...checkedInput.participantProfile,
				...this.participantProfile,
				discordUserId: checkedInput.participantUserId,
			},
		};
		let child;
		try {
			child = this.spawnSyncImpl(this.nodePath, [this.bridgeScript, "--route", this.routeFile], {
				cwd: checkedInput.cwd,
				input: JSON.stringify(payload),
				encoding: "utf8",
				timeout: this.timeoutMs,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			throw projectPolicyError("project_policy_route_unavailable");
		}
		if (!child || child.error || child.status !== 0 || typeof child.stdout !== "string" || child.stdout.trim().length === 0) throw projectPolicyError("project_policy_route_unavailable");
		let result;
		try {
			result = JSON.parse(child.stdout);
		} catch {
			throw projectPolicyError("project_policy_route_unavailable");
		}
		return validateResult(result, checkedInput);
	}
}

export { ACCESS_LEVELS, BACKENDS, PHASES, PUBLIC_REASONS, ROUTE_VERSION, assertInput, validateResult };
