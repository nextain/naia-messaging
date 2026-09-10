import { DELIVERY_UNKNOWN_REASON_CODES, JOB_FAILURE_REASON_CODES, MAX_SAFE_SUMMARY_LENGTH, SAFE_METRIC_KEYS } from "./constants.mjs";
import { constants as osConstants } from "node:os";

import { redactSecrets, sanitizeSummary, boundedSafeExcerpt } from "../../core/redact.mjs";
export { sanitizeSummary, boundedSafeExcerpt };

export function sanitizeFinalResponse(value) {
	if (typeof value !== "string") throw new TypeError("final response must be a string");
	let sanitized = value.replace(/<@!?\d{17,20}>|<@&\d{17,20}>|@everyone|@here/gi, "[MENTION]");
	sanitized = redactSecrets(sanitized).trim();
	if (sanitized.length === 0) throw new Error("final response is empty after sanitization");
	if (sanitized.length > 1_900) throw new Error("final response exceeds 1900 characters");
	return sanitized;
}

export function validateSafeMetrics(metrics = {}) {
	if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
		throw new TypeError("metrics must be an object");
	}
	const safe = {};
	for (const [key, value] of Object.entries(metrics)) {
		if (!SAFE_METRIC_KEYS.has(key)) throw new Error(`unsafe metric key: ${key}`);
		if (typeof value !== "boolean" && (!Number.isSafeInteger(value) || value < 0)) {
			throw new TypeError(`metric ${key} must be boolean or a non-negative safe integer`);
		}
		safe[key] = value;
	}
	return safe;
}

export function assertOnlyKeys(value, allowed, label) {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
	}
}

const CAPABILITY_KEYS = new Set(["structuredProgress", "textActivity", "cancellation", "checkpointResume"]);

export function validateBackendCapabilities(value = {}) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("backendCapabilities must be an object");
	assertOnlyKeys(value, CAPABILITY_KEYS, "backendCapabilities");
	const safe = {};
	for (const [key, enabled] of Object.entries(value)) {
		if (typeof enabled !== "boolean") throw new TypeError(`backend capability ${key} must be boolean`);
		safe[key] = enabled;
	}
	return safe;
}

const ENUMS = {
	backend: new Set(["codex", "claude", "opencode", "grok", "fake"]),
	jobType: new Set(["conversation", "issue_work", "review", "maintenance", "unknown"]),
	phase: new Set(["setup", "planning", "reading", "editing", "testing", "reviewing", "delivering", "recovering"]),
	toolCategory: new Set(["command_execution", "file_change", "read", "search", "file_read", "file_edit", "command", "test", "build", "network", "other"]),
	approvalType: new Set(["read", "write", "execute", "cancel", "retry"]),
	checkpointType: new Set(["job_state"]),
	recoveryAction: new Set(["resume", "safe_retry", "manual_review"]),
	watchdogReason: new Set(["no_progress"]),
	reasonCode: JOB_FAILURE_REASON_CODES,
	deliveryUnknownReason: DELIVERY_UNKNOWN_REASON_CODES,
	terminationKind: new Set(["exited", "signaled"]),
	signal: new Set(Object.keys(osConstants.signals ?? {})),
};

function enumValue(value, label) {
	if (!ENUMS[label]?.has(value)) throw new Error(`${label} is not an allowed value`);
	return value;
}

function count(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
	return value;
}

const PAYLOAD_BUILDERS = {
	job_accepted: (payload) => `Accepted job: ${enumValue(payload.jobType, "jobType")}`,
	request_recorded: (payload) => `Request: ${payload.excerpt}`,
	attempt_reserved: (payload) => `Backend attempt reserved: ${enumValue(payload.backend, "backend")}`,
	attempt_started: (payload) => `Backend attempt started: ${enumValue(payload.backend, "backend")}`,
	backend_ready: (payload) => `Backend ready: ${enumValue(payload.backend, "backend")}`,
	phase_changed: (payload) => `Phase changed: ${enumValue(payload.phase, "phase")}`,
	output_activity: (payload) => `Output activity: ${count(payload.bytes, "bytes")} bytes`,
	progress_reported: (payload) => `Progress: ${payload.excerpt}`,
	prompt_cache_observed: (payload) => {
		const backend = enumValue(payload.backend, "backend");
		const base = `Provider cache receipt (${backend} raw counters): input=${count(payload.inputTokens, "inputTokens")}, cache-read=${count(payload.cacheReadInputTokens, "cacheReadInputTokens")}`;
		const created = payload.cacheCreationInputTokens === undefined ? "" : `, cache-created=${count(payload.cacheCreationInputTokens, "cacheCreationInputTokens")}`;
		return `${base}${created}, output=${count(payload.outputTokens, "outputTokens")}`;
	},
	tool_started: (payload) => payload.toolCategory === undefined ? "Tool started" : `Tool started: ${enumValue(payload.toolCategory, "toolCategory")}`,
	tool_finished: (payload) => payload.toolCategory === undefined ? "Tool finished" : `Tool finished: ${enumValue(payload.toolCategory, "toolCategory")}`,
	approval_required: (payload) => `Approval required: ${enumValue(payload.approvalType, "approvalType")}`,
	checkpoint_saved: (payload) => `Checkpoint saved: ${enumValue(payload.checkpointType, "checkpointType")}`,
	verification_recorded: (payload) => `Verification recorded: ${safeIdentifier(payload.checkId, "checkId")}`,
	attempt_exited: (payload) => {
		const terminationKind = enumValue(payload.terminationKind, "terminationKind");
		if (terminationKind === "exited") {
			if (payload.signal !== undefined) throw new Error("exited termination cannot carry signal");
			return `Backend attempt exited: ${count(payload.exitCode, "exitCode")}`;
		}
		if (payload.exitCode !== undefined) throw new Error("signaled termination cannot carry exitCode");
		return `Backend attempt signaled: ${enumValue(payload.signal, "signal")}`;
	},
	attempt_succeeded: () => "Backend result ready for delivery",
	result_reported: (payload) => `Result: ${payload.excerpt}`,
	retry_scheduled: (payload) => `Retry scheduled: ${count(payload.delayMs, "delayMs")} ms`,
	delivery_started: () => "Delivery started",
	delivery_confirmed: () => "Delivery confirmed",
	delivery_unknown: (payload) => `Delivery result requires review: ${enumValue(payload.reasonCode, "deliveryUnknownReason")}`,
	delivery_failed: (payload) => `Delivery failed: ${enumValue(payload.reasonCode, "reasonCode")}`,
	recovered: (payload) => `Recovered job: ${enumValue(payload.recoveryAction, "recoveryAction")}`,
	profile_replaced: (payload) => payload.reasonCode === undefined
		? "Stale execution profile replaced before launch"
		: `Execution profile replaced: ${enumValue(payload.reasonCode, "reasonCode")}`,
	recovery_review_required: () => "Recovered job requires a fresh request",
	watchdog_intervened: (payload) => `Watchdog intervention: ${enumValue(payload.watchdogReason, "watchdogReason")}`,
	operator_response_sent: () => "Operator channel response sent",
	operator_response_missed: () => "Operator channel response deadline missed",
	cancel_requested: () => "Cancellation requested",
	cancelled: () => "Job cancelled",
	completed: () => "Job completed",
	failed: (payload) => `Job failed: ${enumValue(payload.reasonCode, "reasonCode")}`,
};

const PAYLOAD_KEYS = new Map([
	["job_accepted", new Set(["jobType"])],
	["request_recorded", new Set(["excerpt"])],
	["attempt_reserved", new Set(["backend"])],
	["attempt_started", new Set(["backend"])],
	["backend_ready", new Set(["backend"])],
	["phase_changed", new Set(["phase"])],
	["output_activity", new Set(["bytes"])],
	["progress_reported", new Set(["excerpt"])],
	["prompt_cache_observed", new Set(["backend", "inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "outputTokens"])],
	["tool_started", new Set(["toolCategory"])],
	["tool_finished", new Set(["toolCategory"])],
	["approval_required", new Set(["approvalType"])],
	["checkpoint_saved", new Set(["checkpointType"])],
	["verification_recorded", new Set(["checkId"])],
	["attempt_exited", new Set(["terminationKind", "exitCode", "signal"])],
	["attempt_succeeded", new Set()],
	["result_reported", new Set(["excerpt"])],
	["retry_scheduled", new Set(["delayMs"])],
	["delivery_started", new Set()],
	["delivery_confirmed", new Set()],
	["delivery_unknown", new Set(["reasonCode"])],
	["delivery_failed", new Set(["reasonCode"])],
	["recovered", new Set(["recoveryAction"])],
	["profile_replaced", new Set(["reasonCode"])],
	["recovery_review_required", new Set()],
	["watchdog_intervened", new Set(["watchdogReason"])],
	["operator_response_sent", new Set()],
	["operator_response_missed", new Set()],
	["cancel_requested", new Set()],
	["cancelled", new Set()],
	["completed", new Set()],
	["failed", new Set(["reasonCode"])],
]);

export function safeIdentifier(value, label = "identifier") {
	if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
	if (sanitizeSummary(value) !== value) throw new Error(`${label} resembles sensitive data`);
	return value;
}

export function canonicalTimestamp(value, label = "timestamp") {
	if (typeof value !== "string") throw new TypeError(`${label} must be a canonical ISO timestamp`);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
	return value;
}

export function buildSafeEventSummary(kind, payload = {}) {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("safePayload must be an object");
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 2_048) throw new Error("safePayload exceeds 2048 bytes");
	const allowedKeys = PAYLOAD_KEYS.get(kind);
	if (!allowedKeys) throw new Error(`event kind does not accept adapter payload: ${kind}`);
	assertOnlyKeys(payload, allowedKeys, `${kind} payload`);
	const builder = PAYLOAD_BUILDERS[kind];
	if (!builder) throw new Error(`event kind does not accept adapter payload: ${kind}`);
	return sanitizeSummary(builder(payload));
}
