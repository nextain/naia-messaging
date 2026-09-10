import { randomUUID } from "node:crypto";
import { ALLOWED_TRANSITIONS, EVENT_KINDS, LIFECYCLES } from "./constants.mjs";
import { assertOnlyKeys, buildSafeEventSummary, canonicalTimestamp, safeIdentifier, sanitizeSummary, validateSafeMetrics } from "./sanitize.mjs";

const EVENT_INPUT_KEYS = new Set([
	"jobId",
	"dedupeKey",
	"attemptId",
	"kind",
	"occurredAt",
	"source",
	"safePayload",
	"metrics",
	"redactionLevel",
]);

const EVENT_SOURCES = new Map([
	["job_accepted", new Set(["gateway"])],
	["request_recorded", new Set(["gateway"])],
	["attempt_reserved", new Set(["helper"])],
	["attempt_started", new Set(["helper"])],
	["backend_ready", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["phase_changed", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["output_activity", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["progress_reported", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["prompt_cache_observed", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["tool_started", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["tool_finished", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["approval_required", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["checkpoint_saved", new Set(["helper", "codex", "claude", "grok", "opencode", "fake_backend"])],
	["verification_recorded", new Set(["host_verifier", "backend_claim", "human_review"])],
	["attempt_exited", new Set(["helper"])],
	["attempt_succeeded", new Set(["helper"])],
	["result_reported", new Set(["codex", "claude", "grok", "opencode", "fake_backend"])],
	["retry_scheduled", new Set(["helper", "recovery"])],
	["delivery_started", new Set(["helper"])],
	["delivery_confirmed", new Set(["helper", "recovery"])],
	["delivery_unknown", new Set(["helper", "recovery"])],
	["delivery_failed", new Set(["helper", "recovery"])],
	["recovered", new Set(["recovery"])],
	["profile_replaced", new Set(["recovery", "helper"])],
	["recovery_review_required", new Set(["recovery"])],
	["watchdog_intervened", new Set(["helper"])],
	["operator_response_sent", new Set(["helper"])],
	["operator_response_missed", new Set(["helper"])],
	["cancel_requested", new Set(["helper"])],
	["cancelled", new Set(["helper"])],
	["completed", new Set(["helper"])],
	["failed", new Set(["helper", "recovery"])],
]);

const EXTERNAL_EVENT_SOURCES = new Set(["codex", "claude", "grok", "opencode", "fake_backend"]);

function json(value) {
	return JSON.stringify(value ?? {});
}

function parseJson(value, fallback) {
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function transitionFor(kind, current) {
	switch (kind) {
		case "attempt_reserved":
			return current;
		case "attempt_started":
		case "backend_ready":
		case "phase_changed":
		case "output_activity":
		case "progress_reported":
		case "tool_started":
		case "tool_finished":
		case "checkpoint_saved":
			return "running";
		case "recovered":
		case "profile_replaced":
			return "queued";
		case "recovery_review_required":
			return "recovery_review";
		case "watchdog_intervened":
		case "operator_response_sent":
		case "operator_response_missed":
		case "verification_recorded":
			return current;
		case "attempt_succeeded":
			return "result_ready";
		case "approval_required":
			return "waiting_approval";
		case "retry_scheduled":
			return "retry_wait";
		case "delivery_started":
			return "delivering";
		case "delivery_unknown":
		case "delivery_failed":
		case "delivery_confirmed":
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "cancel_requested":
			return current;
		case "cancelled":
			return "cancelled";
		default:
			return current;
	}
}

export class SessionEventWriter {
	constructor(db, { hardenSidecars }) {
		this.db = db;
		this.hardenSidecars = hardenSidecars;
	}

	recordEvent(input) {
		assertOnlyKeys(input, EVENT_INPUT_KEYS, "event");
		if (!EVENT_KINDS.has(input.kind)) throw new Error(`unsupported event kind: ${input.kind}`);
		if (!EVENT_SOURCES.get(input.kind)?.has(input.source)) throw new Error(`event source ${input.source} cannot produce ${input.kind}`);
		if (EXTERNAL_EVENT_SOURCES.has(input.source) && !input.dedupeKey) throw new Error(`external event ${input.kind} requires a stable dedupeKey`);
		if (EXTERNAL_EVENT_SOURCES.has(input.source) && !input.attemptId) throw new Error(`external event ${input.kind} requires the current attemptId`);
		if (input.dedupeKey) safeIdentifier(input.dedupeKey, "dedupeKey");
		if (input.attemptId !== undefined && input.attemptId !== null) safeIdentifier(input.attemptId, "attemptId");
		if (input.occurredAt !== undefined) canonicalTimestamp(input.occurredAt, "event occurredAt");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const { safePayload, ...eventInput } = input;
			const event = this.appendEvent({ ...eventInput, safeSummary: buildSafeEventSummary(input.kind, safePayload) });
			this.db.exec("COMMIT");
			this.hardenSidecars();
			return event;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}

	appendEvent({
		jobId,
		dedupeKey = `internal:${randomUUID()}`,
		attemptId = null,
		kind,
		occurredAt = new Date().toISOString(),
		source = "helper",
		safeSummary = "",
		metrics = {},
		redactionLevel = "metadata_only",
	}) {
		canonicalTimestamp(occurredAt, "event occurredAt");
		if (attemptId !== null) safeIdentifier(attemptId, "attemptId");
		const job = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
		if (!job) throw new Error(`unknown job: ${jobId}`);
		if (kind === "output_activity" && attemptId) {
			const bucket = Math.floor(Date.parse(occurredAt) / 1_000);
			if (!Number.isFinite(bucket)) throw new Error("output activity needs a valid occurredAt");
			dedupeKey = `output_activity:${attemptId}:${bucket}`;
		}
		const summary = sanitizeSummary(safeSummary);
		const safeMetrics = validateSafeMetrics(metrics);
		const duplicate = this.db.prepare("SELECT * FROM job_events WHERE job_id = ? AND dedupe_key = ?").get(jobId, dedupeKey);
		if (duplicate) {
			if (duplicate.kind !== kind || duplicate.attempt_id !== attemptId || duplicate.source !== source) {
				throw new Error(`dedupe key conflict: ${dedupeKey}`);
			}
			if (kind !== "output_activity" && (duplicate.occurred_at !== occurredAt || duplicate.safe_summary !== summary || duplicate.metrics_json !== json(safeMetrics) || duplicate.redaction_level !== redactionLevel)) {
				throw new Error(`dedupe key content conflict: ${dedupeKey}`);
			}
			return this.mapEvent(duplicate);
		}
		if (attemptId && !new Set(["attempt_reserved", "attempt_started"]).has(kind) && job.attempt_id && attemptId !== job.attempt_id) throw new Error(`stale attempt event rejected: ${attemptId}`);
		if (!new Set(["metadata_only", "local_safe"]).has(redactionLevel)) throw new Error(`unsupported redaction level: ${redactionLevel}`);
		if (!new Set(["gateway", "helper", "codex", "claude", "grok", "opencode", "fake_backend", "host_verifier", "backend_claim", "human_review", "recovery"]).has(source)) {
			throw new Error(`unsupported event source: ${source}`);
		}
		const sequence = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM job_events WHERE job_id = ?").get(jobId).next;
		const eventId = randomUUID();
		const lifecycle = transitionFor(kind, job.lifecycle);
		if (!LIFECYCLES.has(lifecycle)) throw new Error(`invalid lifecycle: ${lifecycle}`);
		if (!ALLOWED_TRANSITIONS.get(job.lifecycle)?.has(lifecycle)) {
			throw new Error(`invalid lifecycle transition: ${job.lifecycle} -> ${lifecycle}`);
		}
		const insertResult = this.db.prepare(`
			INSERT INTO job_events(event_id, dedupe_key, job_id, attempt_id, sequence, kind, occurred_at, source,
				safe_summary, metrics_json, redaction_level)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(eventId, dedupeKey, jobId, attemptId, sequence, kind, occurredAt, source, summary, json(safeMetrics), redactionLevel);
		const progressKinds = new Set(["attempt_started", "backend_ready", "phase_changed", "output_activity", "progress_reported", "tool_started", "tool_finished", "checkpoint_saved", "verification_recorded"]);
		const projectedActivityKinds = new Set(["attempt_started", "backend_ready", "phase_changed", "output_activity", "tool_started", "tool_finished", "checkpoint_saved", "verification_recorded"]);
		const childAlive = kind === "attempt_started" ? 1 : ["attempt_exited", "failed", "completed", "cancelled", "recovered", "recovery_review_required", "delivery_unknown", "delivery_failed"].includes(kind) ? 0 : job.child_alive;
		const deliveryState = kind === "delivery_started" ? "sending" : kind === "delivery_confirmed" ? "delivered" : kind === "delivery_unknown" ? "unknown" : kind === "delivery_failed" ? "failed" : job.delivery_state;
		this.db.prepare(`
			UPDATE jobs SET attempt_id = COALESCE(?, attempt_id), lifecycle = ?, updated_at = ?,
				started_at = CASE WHEN ? = 'attempt_started' THEN COALESCE(started_at, ?) ELSE started_at END,
				last_progress_at = CASE WHEN ? THEN ? ELSE last_progress_at END,
				current_activity = CASE WHEN ? THEN ? ELSE current_activity END,
				waiting_reason = CASE WHEN ? = 'approval_required' THEN ? ELSE waiting_reason END,
				child_alive = ?, delivery_state = ?, recovery_state = CASE WHEN ? = 'recovered' THEN 'resuming' WHEN ? = 'recovery_review_required' THEN 'review_required' ELSE recovery_state END,
				latest_safe_error = CASE WHEN ? = 'failed' THEN ? ELSE latest_safe_error END
			WHERE job_id = ?
		`).run(attemptId, lifecycle, occurredAt, kind, occurredAt, progressKinds.has(kind) ? 1 : 0, occurredAt,
			projectedActivityKinds.has(kind) ? 1 : 0, summary, kind, summary, childAlive, deliveryState, kind, kind, kind, summary, jobId);
		// Failed jobs retain only their encrypted recovery request so an explicit
		// operator restart can retry the bounded request after a terminal failure.
		if (["delivery_confirmed", "completed", "cancelled", "recovery_review_required"].includes(kind)) this.db.prepare("DELETE FROM job_recovery WHERE job_id = ?").run(jobId);
		return { ordinal: Number(insertResult.lastInsertRowid), eventId, dedupeKey, jobId, attemptId, sequence, kind, occurredAt, source, safeSummary: summary, metrics: safeMetrics, redactionLevel };
	}

	mapEvent(event) {
		return {
			ordinal: event.ordinal,
			eventId: event.event_id,
			dedupeKey: event.dedupe_key,
			jobId: event.job_id,
			attemptId: event.attempt_id,
			sequence: event.sequence,
			kind: event.kind,
			occurredAt: event.occurred_at,
			source: event.source,
			safeSummary: event.safe_summary,
			metrics: parseJson(event.metrics_json, {}),
			redactionLevel: event.redaction_level,
		};
	}

	recordEvidence({ jobId, checkId, attemptId = null, revision, producer, verifier, result, observedAt = new Date().toISOString(), metrics = {} }) {
		safeIdentifier(jobId, "jobId");
		if (attemptId !== null) safeIdentifier(attemptId, "attemptId");
		safeIdentifier(revision, "revision");
		canonicalTimestamp(observedAt, "evidence observedAt");
		if (!new Set(["passed", "failed", "missing"]).has(result)) throw new Error(`unsupported evidence result: ${result}`);
		if (!new Set(["host_verifier", "backend_claim", "human_review"]).has(producer)) throw new Error(`unsupported evidence producer: ${producer}`);
		const check = this.db.prepare("SELECT * FROM required_checks WHERE job_id = ? AND check_id = ?").get(jobId, checkId);
		if (!check) throw new Error(`unknown required check: ${checkId}`);
		const currentJob = this.db.prepare("SELECT attempt_id FROM jobs WHERE job_id = ?").get(jobId);
		if (!currentJob.attempt_id || attemptId !== currentJob.attempt_id) throw new Error(`stale attempt evidence rejected: ${attemptId}`);
		if (revision !== check.revision && !check.allow_reuse) throw new Error(`evidence revision mismatch for ${checkId}`);
		const label = sanitizeSummary(check.safe_label);
		const safeVerifier = safeIdentifier(verifier, "verifier");
		const safeMetrics = validateSafeMetrics(metrics);
		const evidenceId = randomUUID();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare(`
				INSERT INTO evidence(evidence_id, job_id, check_id, attempt_id, revision, kind, safe_label,
					required, result, producer, verifier, observed_at, metrics_json)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(evidenceId, jobId, checkId, attemptId, revision, check.kind, label, check.required, result, producer, safeVerifier, observedAt, json(safeMetrics));
			this.appendEvent({ jobId, attemptId, dedupeKey: `verification:${evidenceId}`, kind: "verification_recorded", occurredAt: observedAt, source: producer, safeSummary: buildSafeEventSummary("verification_recorded", { checkId }), metrics: safeMetrics });
			this.db.exec("COMMIT");
			this.hardenSidecars();
			return evidenceId;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}

	eventsAfter({ jobId = null, afterOrdinal = 0 } = {}) {
		const rows = jobId
			? this.db.prepare("SELECT * FROM job_events WHERE job_id = ? AND ordinal > ? ORDER BY ordinal").all(jobId, afterOrdinal)
			: this.db.prepare("SELECT * FROM job_events WHERE ordinal > ? ORDER BY ordinal").all(afterOrdinal);
		return rows.map((event) => this.mapEvent(event));
	}
}
