export const DB_SCHEMA_VERSION = 6;
export const OUTPUT_SCHEMA_VERSION = 1;

export const EVENT_KINDS = new Set([
	"job_accepted",
	"request_recorded",
	"attempt_reserved",
	"attempt_started",
	"backend_ready",
	"phase_changed",
	"output_activity",
	"progress_reported",
	"prompt_cache_observed",
	"tool_started",
	"tool_finished",
	"approval_required",
	"checkpoint_saved",
	"verification_recorded",
	"attempt_exited",
	"attempt_succeeded",
	"result_reported",
	"retry_scheduled",
	"delivery_started",
	"delivery_confirmed",
	"delivery_unknown",
	"delivery_failed",
	"recovered",
	"profile_replaced",
	"recovery_review_required",
	"watchdog_intervened",
	"operator_response_sent",
	"operator_response_missed",
	"cancel_requested",
	"cancelled",
	"completed",
	"failed",
]);

export const TERMINAL_LIFECYCLES = new Set([
	"completed",
	"failed",
	"cancelled",
	"recovery_review",
]);

export const LIFECYCLES = new Set([
	"queued",
	"running",
	"waiting_approval",
	"retry_wait",
	"result_ready",
	"delivering",
	...TERMINAL_LIFECYCLES,
]);

export const ACTIVITY_DETAILS = new Set(["structured", "text_activity", "unsupported"]);

export const SAFE_METRIC_KEYS = new Set([
	"bytes",
	"count",
	"durationMs",
	"exitCode",
	"passed",
	"failed",
	"missing",
	"total",
	"queuePosition",
	"inputTokens",
	"cachedInputTokens",
	"cacheReadInputTokens",
	"cacheCreationInputTokens",
	"outputTokens",
	"truncated",
]);

export const DEFAULT_SOFT_SILENCE_MS = 120_000;
export const DEFAULT_SERVICE_STALE_MS = 30_000;
export { MAX_SAFE_SUMMARY_LENGTH } from "../../core/redact.mjs";

export const JOB_FAILURE_REASON_CODES = new Set([
	"timeout",
	"process_exit",
	"provider_quota_exhausted",
	"authorization",
	"delivery_unknown",
	"internal_error",
	"no_progress_timeout",
	"approval_ui_detected",
	"context_changed_restart_required",
	"discord_history_load_failed",
	"backend_version_probe_failed",
	"backend_authentication_failed",
	"backend_invocation_invalid",
	"backend_spawn_failed",
	"mutation_window_closed",
]);

export const DELIVERY_UNKNOWN_REASON_CODES = new Set([
	"network_result_unknown",
	"server_response_unknown",
	"receipt_identity_mismatch",
	"delivery_commit_unknown",
	"recovery_interrupted",
]);

export const DISCORD_SERVICE_FAILURE_REASONS = new Set([
	"configuration_invalid",
	"context_invalid",
	"credential_unavailable",
	"discord_token_already_owned",
	"discord_token_lock_unavailable",
	"context_changed_restart_required",
	"startup_or_runtime_failure",
	"failure_status_invalid",
]);

export const ALLOWED_TRANSITIONS = new Map([
	["queued", new Set(["queued", "running", "cancelled", "failed", "recovery_review"])],
	["running", new Set(["queued", "running", "waiting_approval", "retry_wait", "result_ready", "delivering", "failed", "cancelled", "recovery_review"])],
	["waiting_approval", new Set(["queued", "waiting_approval", "running", "cancelled", "failed", "recovery_review"])],
	["retry_wait", new Set(["retry_wait", "queued", "running", "cancelled", "failed", "recovery_review"])],
	["result_ready", new Set(["queued", "result_ready", "delivering", "completed", "cancelled", "failed", "recovery_review"])],
	["delivering", new Set(["delivering", "completed", "retry_wait", "recovery_review", "failed"])],
	["recovery_review", new Set(["recovery_review", "queued", "completed", "failed", "cancelled"])],
	["completed", new Set(["completed"])],
	["failed", new Set(["failed"])],
	["cancelled", new Set(["cancelled"])],
]);
