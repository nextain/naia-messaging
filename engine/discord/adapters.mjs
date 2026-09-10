import { createHash } from "node:crypto";
import { grokDiscordCost } from "./grok-cost-profile.mjs";

const CODEX_REASONING_BY_COST_PROFILE = Object.freeze({ control: "medium", balanced: "low", economy: "low" });

const ADAPTERS = new Map([
	["codex", {
		backendId: "codex",
		activityDetail: "structured",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "codex", cwd, childHome = null, allowedPaths = [], sandbox = "workspace-write", approvalPolicy = "never", model = null, costProfile = "balanced", reasoningEffort = null, networkAccess = false, projectInstructions = false, loginMethod = null, resultPath = null }) {
			if (approvalPolicy !== "never") throw new Error("Codex child approval policy must be never");
			if (!new Set(["read-only", "workspace-write", "danger-full-access"]).has(sandbox)) throw new Error("unsupported Codex sandbox");
			if (!Object.hasOwn(CODEX_REASONING_BY_COST_PROFILE, costProfile)) throw new Error("unsupported Codex cost profile");
			const selectedReasoningEffort = reasoningEffort ?? CODEX_REASONING_BY_COST_PROFILE[costProfile];
			if (!selectedReasoningEffort || !new Set(["low", "medium", "high", "max"]).has(selectedReasoningEffort)) throw new Error("unsupported Codex reasoning effort");
			const args = ["exec", "--json", ...(!projectInstructions ? ["--ephemeral", "--strict-config"] : []), "--config", 'approval_policy="never"', "--config", `model_reasoning_effort="${selectedReasoningEffort}"`, "--sandbox", sandbox, "--cd", cwd, "--ignore-user-config"];
            if (!projectInstructions) args.push("--config", "project_doc_max_bytes=0", "--ignore-rules");
            if (loginMethod === "chatgpt") args.push("--config", 'forced_login_method="chatgpt"');
            if (resultPath) args.push("--output-last-message", resultPath);
			// Credential stores are isolated under the child HOME. Codex's
			// workspace-write sandbox otherwise denies gcloud/az/Vercel writes there.
			for (const path of [...allowedPaths, childHome].filter((path) => path && path !== cwd)) args.push("--add-dir", path);
			if (networkAccess && sandbox === "workspace-write") {
				args.push("--config", "sandbox_workspace_write.network_access=true");
			}
			if (networkAccess && sandbox === "read-only") throw new Error("Codex network access requires writable access");
			if (model) args.push("--model", model);
			return { command: executable, args };
		},
		parse: parseCodex,
	}],
	["claude", {
		backendId: "claude",
		activityDetail: "structured",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "claude", cwd, childHome = null, allowedPaths = [], permissionMode = "plan", approvalPolicy = "never", model = null }) {
			if (approvalPolicy !== "never") throw new Error("Claude child approval policy must be never");
			if (!new Set(["plan", "bypassPermissions"]).has(permissionMode)) throw new Error("unsupported Claude permission mode");
			const args = ["-p", "--safe-mode", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "--permission-mode", permissionMode];
			if (permissionMode === "plan") {
				// Keep the plan route's provider surface explicit. This controls
				// Claude's built-in tools and MCP configuration; it is not an OS
				// or workspace filesystem boundary.
				args.push("--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
			} else {
				args.push("--dangerously-skip-permissions");
			}
			for (const path of [...allowedPaths, childHome].filter((path) => path && path !== cwd)) args.push("--add-dir", path);
			if (model) args.push("--model", model);
			return {
				command: executable,
				args,
			};
		},
		parse: parseClaude,
	}],
	["opencode", {
		backendId: "opencode",
		activityDetail: "structured",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "opencode", cwd, auto = false, model = null }) {
			const args = ["run", "--format", "json", "--dir", cwd, "--pure"];
			if (!auto) args.push("--agent", "build");
			if (model) args.push("--model", model);
			if (auto) args.push("--auto");
			return { command: executable, args };
		},
		parse: parseOpencode,
	}],
	["grok", {
		backendId: "grok",
		activityDetail: "structured",
		// The installed Grok CLI takes a single-turn prompt from a real file
		// path. `--prompt-file -` is not stdin: the CLI tries to open a file
		// literally named `-` and exits 1 before reading anything. The runner
		// therefore stages the prompt in the child home for this backend.
		promptDelivery: "file",
		capabilities: { structuredProgress: true, textActivity: true, cancellation: true, checkpointResume: false },
		command({ executable = "grok", cwd, promptPath = null, permissionMode = "plan", sandbox = null, approvalPolicy = "never", model = "grok-4.6", costProfile = "balanced", reasoningEffort = null }) {
			if (approvalPolicy !== "never") throw new Error("Grok child approval policy must be never");
			if (!new Set(["plan", "bypassPermissions"]).has(permissionMode)) throw new Error("unsupported Grok permission mode");
			const selectedSandbox = sandbox ?? (permissionMode === "plan" ? "read-only" : "workspace");
			if (!new Set(["read-only", "workspace"]).has(selectedSandbox)) throw new Error("unsupported Grok sandbox");
			if (permissionMode === "plan" && selectedSandbox !== "read-only") throw new Error("Grok plan mode requires read-only sandbox");
			if (permissionMode === "bypassPermissions" && selectedSandbox !== "workspace") throw new Error("Grok writable mode requires workspace sandbox");
			if (typeof promptPath !== "string" || !promptPath) throw new Error("Grok requires a staged prompt file");
			const selectedReasoningEffort = reasoningEffort ?? grokDiscordCost(costProfile).reasoningEffort;
			if (!selectedReasoningEffort || !new Set(["low", "medium", "high", "max"]).has(selectedReasoningEffort)) throw new Error("unsupported Grok reasoning effort");
			// --verbatim keeps the host-authored contract prompt from being
			// reinterpreted as CLI syntax; the request text inside it comes from
			// a Discord participant.
			const args = ["--output-format", "streaming-messages-json", "--permission-mode", permissionMode, "--cwd", cwd, "--verbatim", "--prompt-file", promptPath, "--reasoning-effort", selectedReasoningEffort];
			if (model) args.push("--model", model);
			return { command: executable, args };
		},
		parse: parseGrok,
	}],
]);

const MINIMUM_VERSIONS = new Map([["codex", [0, 146, 0]], ["claude", [2, 1, 220]], ["opencode", [1, 18, 0]], ["grok", [1, 0, 0]]]);
const APPROVAL_REQUEST_PATTERN = /\b(?:approval|permission)[ _-]?(?:required|request)\b/i;
export const PROVIDER_QUOTA_FAILURE_REASON = "provider_quota_exhausted";
const PROVIDER_QUOTA_CODES = new Set([
	"insufficient_quota",
	"quota_exceeded",
	"usage_limit_exceeded",
	"usage_limit_reached",
	"billing_hard_limit_reached",
	"insufficient_balance",
	"usage_balance_exhausted",
	"payment_required",
]);
const RAW_QUOTA_STATUS_PATTERN = /["'](?:http_status|httpStatus|status_code|statusCode)["']\s*:\s*["']?402\b/i;
const RAW_QUOTA_CODE_PATTERN = new RegExp(`["'](?:code|error_code|errorCode|reason)["']\\s*:\\s*["']?(?:${[...PROVIDER_QUOTA_CODES].join("|")})["']?\\b`, "i");

export function approvalRequestedText(value) {
	return APPROVAL_REQUEST_PATTERN.test(String(value));
}

function structuredApprovalRequested(message) {
	const eventType = String(message?.type ?? "");
	const itemType = String(message?.item?.type ?? "");
	return /(?:approval|permission)[_.-]?(?:required|request)/i.test(eventType)
		|| /(?:approval|permission)[_.-]?(?:required|request)/i.test(itemType);
}

export function getBackendAdapter(backendId) {
	const adapter = ADAPTERS.get(backendId);
	if (!adapter) throw new Error(`unsupported backend adapter: ${backendId}`);
	return adapter;
}

// commandOptionsForProfile() 이 만든 옵션을 되읽어 읽기 전용 실행인지 판정한다.
// 프로필 객체를 넘겨받지 못한 호출부(자식 환경 준비 등)도 같은 답을 얻어야
// 읽기 전용 작업에 네트워크·자격 증명이 새로 들어가지 않는다. Codex는
// sandbox를 생략하면 workspace-write를 사용하므로, 명시적인 read-only만
// 읽기 전용으로 판정한다.
export function readOnlyBackendOptions(backendId, options = {}) {
	getBackendAdapter(backendId);
	if (backendId === "codex") return options.sandbox === "read-only";
	if (backendId === "opencode") return options.auto !== true;
	if (backendId === "grok") return options.permissionMode === "plan" && options.sandbox === "read-only";
	return options.permissionMode !== "bypassPermissions";
}

export function assertSupportedBackendVersion(backendId, versionOutput) {
	getBackendAdapter(backendId);
	const match = String(versionOutput).match(/\b(\d+)\.(\d+)\.(\d+)\b/);
	if (!match) throw new Error(`${backendId} version could not be determined`);
	const actual = match.slice(1).map(Number);
	const minimum = MINIMUM_VERSIONS.get(backendId);
	for (let index = 0; index < 3; index += 1) {
		if (actual[index] > minimum[index]) return actual.join(".");
		if (actual[index] < minimum[index]) throw new Error(`${backendId} version is not supported`);
	}
	return actual.join(".");
}

function normalizedProviderQuotaCode(value) {
	if (typeof value !== "string" || value.length > 80) return null;
	const normalized = value.trim().toLowerCase().replace(/[ -]+/g, "_");
	return PROVIDER_QUOTA_CODES.has(normalized) ? normalized : null;
}

function isFailureEnvelope(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const type = String(value.type ?? "").toLowerCase();
	return type === "error"
		|| type === "turn.failed"
		|| type === "turn_failed"
		|| (type === "result" && (value.is_error === true || String(value.subtype ?? "").toLowerCase() === "error"))
		|| value.is_error === true
		|| (value.error && typeof value.error === "object" && !Array.isArray(value.error));
}

function providerQuotaReasonFromStructuredFailure(value) {
	if (!isFailureEnvelope(value)) return null;
	const candidates = [
		value,
		value.error,
		value.message,
		value.details,
		value.details?.error,
	].filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
	for (const candidate of candidates) {
		for (const key of ["http_status", "httpStatus", "status_code", "statusCode", "status"]) {
			if (candidate[key] === 402 || String(candidate[key] ?? "") === "402") return PROVIDER_QUOTA_FAILURE_REASON;
		}
		for (const key of ["code", "error_code", "errorCode", "reason"]) {
			if (normalizedProviderQuotaCode(candidate[key])) return PROVIDER_QUOTA_FAILURE_REASON;
		}
	}
	return null;
}

// Provider output is intentionally reduced to one allowlisted reason. The raw
// stderr line is never returned or stored; an unparseable line only produces a
// pending reason, which the runner may use after a failed process exit. This
// prevents a successful response that merely prints an illustrative envelope
// from becoming a provider failure.
export function classifyBackendFailure({ message = null, line = null } = {}) {
	const structuredReason = providerQuotaReasonFromStructuredFailure(message);
	if (structuredReason) return structuredReason;
	if (message !== null && message !== undefined) return null;
	if (typeof line !== "string") return null;
	try {
		const parsed = JSON.parse(line);
		return providerQuotaReasonFromStructuredFailure(parsed);
	} catch {}
	return RAW_QUOTA_STATUS_PATTERN.test(line) || RAW_QUOTA_CODE_PATTERN.test(line)
		? PROVIDER_QUOTA_FAILURE_REASON
		: null;
}

function activity(bytes) {
	return bytes > 0 ? [{ kind: "output_activity", safePayload: { bytes }, metrics: { bytes } }] : [];
}

function nonNegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cacheReceipt(usage, backendId) {
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return [];
	const inputTokens = nonNegativeInteger(usage.input_tokens);
	const cacheReadInputTokens = nonNegativeInteger(backendId === "codex" ? usage.cached_input_tokens : usage.cache_read_input_tokens);
	const outputTokens = nonNegativeInteger(usage.output_tokens);
	if (inputTokens === null || cacheReadInputTokens === null || outputTokens === null) return [];
	const safePayload = { backend: backendId, inputTokens, cacheReadInputTokens, outputTokens };
	if (backendId === "claude") {
		const cacheCreationInputTokens = nonNegativeInteger(usage.cache_creation_input_tokens);
		if (cacheCreationInputTokens === null) return [];
		safePayload.cacheCreationInputTokens = cacheCreationInputTokens;
	}
	const metrics = { inputTokens, cacheReadInputTokens, outputTokens };
	if (safePayload.cacheCreationInputTokens !== undefined) metrics.cacheCreationInputTokens = safePayload.cacheCreationInputTokens;
	return [{ kind: "prompt_cache_observed", safePayload, metrics }];
}

const CODEX_TOOL_CATEGORIES = new Map([
	["command_execution", "command_execution"],
	["file_change", "file_change"],
	["web_search", "search"],
]);

const CLAUDE_TOOL_CATEGORIES = new Map([
	["Bash", "command_execution"],
	["Edit", "file_change"],
	["NotebookEdit", "file_change"],
	["Write", "file_change"],
	["Read", "read"],
	["Glob", "search"],
	["Grep", "search"],
	["WebSearch", "search"],
]);

function optionalToolPayload(category) {
	return category ? { toolCategory: category } : {};
}

function parseCodex(message, rawBytes) {
	const events = [];
	switch (message.type) {
		case "thread.started":
			events.push({ kind: "backend_ready", safePayload: { backend: "codex" } });
			break;
		case "turn.started":
			break;
		case "item.started":
			if (message.item?.type && !new Set(["reasoning", "agent_message"]).has(message.item.type)) {
				events.push({ kind: "tool_started", safePayload: optionalToolPayload(CODEX_TOOL_CATEGORIES.get(message.item.type)) });
			}
			break;
		case "item.completed":
			if (message.item?.type && !new Set(["reasoning", "agent_message"]).has(message.item.type)) {
				events.push({ kind: "tool_finished", safePayload: optionalToolPayload(CODEX_TOOL_CATEGORIES.get(message.item.type)) });
			}
			events.push(...activity(rawBytes));
			break;
		case "turn.completed":
			events.push(...cacheReceipt(message.usage, "codex"));
			break;
		default:
			if (message.type === "error" || message.type === "turn.failed") break;
			events.push(...activity(rawBytes));
	}
	return events;
}

function claudeBlocks(message) {
	return Array.isArray(message?.message?.content) ? message.message.content : Array.isArray(message?.content) ? message.content : [];
}

function parseClaude(message, rawBytes) {
	const events = [];
	if (message.type === "system" && message.subtype === "init") {
		events.push({ kind: "backend_ready", safePayload: { backend: "claude" } });
		return events;
	}
	if (message.type === "assistant") {
		for (const block of claudeBlocks(message)) {
			if (block.type === "tool_use") events.push({ kind: "tool_started", safePayload: optionalToolPayload(CLAUDE_TOOL_CATEGORIES.get(block.name)) });
		}
		events.push(...activity(rawBytes));
		return events;
	}
	if (message.type === "user") {
		return events;
	}
	if (message.type === "stream_event") return activity(rawBytes);
	if (message.type === "result") {
		events.push(...cacheReceipt(message.usage, "claude"));
		return events;
	}
	return events;
}

const GROK_TOOL_CATEGORIES = new Map([
	["run_terminal_command", "command_execution"],
	["search_replace", "file_change"],
	["write", "file_change"],
	["read_file", "read"],
	["grep", "search"],
	["web_search", "search"],
]);

function parseGrok(message, rawBytes) {
	const events = [];
	if (message.type === "system" && message.subtype === "init") {
		events.push({ kind: "backend_ready", safePayload: { backend: "grok" } });
		return events;
	}
	if (message.type === "assistant") {
		for (const block of claudeBlocks(message)) {
			if (block.type === "tool_use") events.push({ kind: "tool_started", safePayload: optionalToolPayload(GROK_TOOL_CATEGORIES.get(block.name)) });
		}
		events.push(...activity(rawBytes));
		return events;
	}
	if (message.type === "result") {
		events.push(...cacheReceipt(message.usage, "grok"));
		return events;
	}
	if (message.sessionUpdate || message.type === "session_update") {
		events.push({ kind: "backend_ready", safePayload: { backend: "grok" } });
		events.push(...activity(rawBytes));
		return events;
	}
	return activity(rawBytes);
}

// OpenCode names its tools differently from Codex and Claude. Only the tools
// whose category is unambiguous are mapped; anything else stays generic, the
// same way an unknown Codex or Claude tool does. This map existed only as a
// call to an undefined `toolCategory`, so the first tool line of any real
// OpenCode job threw a ReferenceError inside the stream reader and terminated
// the attempt as internal_error.
const OPENCODE_TOOL_CATEGORIES = new Map([
	["bash", "command_execution"],
	["edit", "file_change"],
	["patch", "file_change"],
	["write", "file_change"],
	["read", "read"],
	["glob", "search"],
	["grep", "search"],
	["list", "search"],
	["webfetch", "network"],
]);

const OPENCODE_FAILURE_REASONS = new Set([
	"aborted",
	"cancelled",
	"canceled",
	"error",
	"failed",
	"failure",
	"interrupted",
	"interrupt",
	"length",
]);
const OPENCODE_SUCCESS_REASONS = new Set(["stop"]);

function normalizedOpenCodeValue(value) {
	return typeof value === "string" ? value.trim().toLowerCase().replace(/[ _]+/g, "-") : null;
}

function inspectOpenCodeOutcome(message) {
	if (message.type === "error") return "failure";
	if (message.error || message.is_error === true) return "failure";
	if (message.type === "tool_use") {
		const status = normalizedOpenCodeValue(message.part?.state?.status ?? message.state?.status);
		// A tool can report a recoverable error while the model continues and
		// produces a validated terminal stop. Keep that intermediate state out of
		// the attempt outcome; terminal step/session markers still decide whether
		// the attempt succeeded. Explicit abort/interruption states remain
		// terminal failures.
		if (status === "error") return null;
		return OPENCODE_FAILURE_REASONS.has(status) ? "failure" : null;
	}
	if (message.type === "step_finish") {
		const reason = normalizedOpenCodeValue(message.part?.reason ?? message.reason);
		if (OPENCODE_FAILURE_REASONS.has(reason)) return "failure";
		return OPENCODE_SUCCESS_REASONS.has(reason) ? "success" : null;
	}
	if (message.type === "session_end" || message.type === "result") {
		const status = normalizedOpenCodeValue(message.status ?? message.subtype ?? message.part?.status ?? message.part?.reason);
		if (OPENCODE_FAILURE_REASONS.has(status)) return "failure";
		return OPENCODE_SUCCESS_REASONS.has(status) || new Set(["completed", "success"]).has(status) ? "success" : null;
	}
	return null;
}

function parseOpencode(message, rawBytes) {
	const events = [];
	if (message.type === "step_start") events.push({ kind: "phase_changed", safePayload: { phase: "planning" } });
	if (message.type === "text") events.push(...activity(rawBytes));
	if (message.type === "tool_use") {
		const tool = message.part?.tool ?? "unknown";
		const status = message.part?.state?.status ?? "running";
		events.push({ kind: status === "completed" || status === "error" ? "tool_finished" : "tool_started", safePayload: optionalToolPayload(OPENCODE_TOOL_CATEGORIES.get(tool)) });
	}
	return events;
}

export function inspectBackendLine({ backendId, line, attemptId, lineNumber }) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		const pendingFailureReasonCode = classifyBackendFailure({ backendId, line });
		return { structured: false, outcome: null, failureReasonCode: null, pendingFailureReasonCode, transientResult: null, assistantText: null, approvalRequested: approvalRequestedText(line), events: activity(Buffer.byteLength(line, "utf8")).map((event, eventIndex) => ({
			...event,
			dedupeKey: eventKey(backendId, attemptId, lineNumber, eventIndex, event.kind),
		})) };
	}
    const validObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const validShape = validObject(message)
        && (!message.item || validObject(message.item))
        && (message.type !== "turn.completed" || message.usage === undefined || validObject(message.usage));
    if (!validShape) return { structured: false, outcome: null, failureReasonCode: null, pendingFailureReasonCode: null, transientResult: null, assistantText: null, approvalRequested: false, events: [] };
	const rawBytes = Buffer.byteLength(line, "utf8");
	const approvalRequested = structuredApprovalRequested(message);
	const failureReasonCode = classifyBackendFailure({ backendId, message });
	const codexCompletion = message.type === "turn.completed"
		&& (message.status === undefined || new Set(["completed", "success"]).has(message.status));
	const opencodeCompletion = backendId === "opencode" && new Set(["step_finish", "session_end", "result", "error", "tool_use"]).has(message.type);
	const observedOutcome = backendId === "codex"
		? codexCompletion ? "success" : new Set(["turn.failed", "error"]).has(message.type) ? "failure" : null
		: backendId === "opencode" ? opencodeCompletion ? inspectOpenCodeOutcome(message) : null
		: message.type === "result" ? (message.is_error === true || message.subtype === "error" ? "failure" : message.subtype === "success" && message.is_error !== true ? "success" : null) : null;
	const outcome = failureReasonCode ? "failure" : observedOutcome;
	let transientResult = null;
	let assistantText = null;
	if (backendId === "codex" && message.type === "item.completed" && message.item?.type === "agent_message" && typeof message.item.text === "string") transientResult = message.item.text;
	if (backendId === "codex" && message.type === "item.completed" && message.item?.type === "agent_message" && typeof message.item.text === "string") assistantText = message.item.text;
	if (backendId === "claude" && message.type === "assistant") {
		const text = claudeBlocks(message).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
		if (text) assistantText = text;
	}
	if (backendId === "claude" && message.type === "result" && outcome === "success" && typeof message.result === "string") transientResult = message.result;
	if (backendId === "grok" && message.type === "assistant") {
		const text = claudeBlocks(message).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
		if (text) assistantText = text;
	}
	if (backendId === "grok" && message.type === "result" && outcome === "success" && typeof message.result === "string") transientResult = message.result;
	if (backendId === "opencode" && message.type === "text" && typeof message.part?.text === "string") {
		transientResult = message.part.text;
		assistantText = message.part.text;
	}
	const receipt = {};
    if (backendId === "codex" && message.type === "thread.started" && typeof message.thread_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(message.thread_id)) receipt.threadId = message.thread_id;
    if (backendId === "codex" && message.type === "turn.completed") {
        receipt.usage = {};
        for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"]) if (Number.isSafeInteger(message.usage?.[key]) && message.usage[key] >= 0) receipt.usage[key] = message.usage[key];
    }
    return { structured: true, receipt, outcome, failureReasonCode, pendingFailureReasonCode: null, transientResult, assistantText, approvalRequested, events: getBackendAdapter(backendId).parse(message, rawBytes).map((event, eventIndex) => ({
		...event,
		dedupeKey: eventKey(backendId, attemptId, lineNumber, eventIndex, event.kind),
	})) };
}

export function parseBackendLine(input) {
	return inspectBackendLine(input).events;
}

function eventKey(backendId, attemptId, lineNumber, eventIndex, kind) {
	const digest = createHash("sha256").update(`${backendId}\0${attemptId}\0${lineNumber}\0${eventIndex}\0${kind}`).digest("hex").slice(0, 32);
	return `${backendId}:${digest}`;
}
