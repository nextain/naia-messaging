import { LIFECYCLES, OUTPUT_SCHEMA_VERSION } from "./constants.mjs";
import { observeOwnedProcess, projectActivityHealth, projectCompletionAssessment, projectServiceHealth } from "./projector.mjs";
import { safeIdentifier } from "./sanitize.mjs";
import { validateDurableExecutionBinding } from "./execution-profile.mjs";

const OPERATIONAL_LIFECYCLE_PREDICATE = "lifecycle IN ('queued', 'running', 'waiting_approval', 'retry_wait', 'result_ready', 'delivering')";
const DEFAULT_JOB_PAGE_SIZE = 100;
const MAX_JOB_PAGE_SIZE = 1_000;
const DEFAULT_OPERATIONAL_JOB_LIMIT = 256;

function jobPageLimit(value) {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_JOB_PAGE_SIZE) throw new Error(`job page limit must be between 1 and ${MAX_JOB_PAGE_SIZE}`);
	return value;
}

function parseJson(value, fallback) {
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

export class SessionStoreReader {
	constructor(db, { loadGatewayState, eventsAfter }) {
		this.db = db;
		this.loadGatewayState = loadGatewayState;
		this.eventsAfter = eventsAfter;
	}

	operationalSnapshot({ nowMs = Date.now(), staleAfterMs, operationalLimit = DEFAULT_OPERATIONAL_JOB_LIMIT } = {}) {
		const service = this.db.prepare("SELECT * FROM service_state WHERE id = 1").get();
		const serviceHealth = projectServiceHealth(service, nowMs, staleAfterMs);
		const operationalTotal = this.operationalJobCount();
		const jobs = this.listOperationalJobs({ nowMs, serviceHealth, limit: operationalLimit });
		const operationalOverflow = Math.max(0, operationalTotal - jobs.length);
		const historicalAttention = this.historicalAttentionCounts();
		const gateway = this.loadGatewayState();
		const status = {
			schemaVersion: OUTPUT_SCHEMA_VERSION,
			service: serviceHealth,
			gateway: { resumable: Boolean(gateway.sessionId && Number.isSafeInteger(gateway.sequence)), sequence: gateway.sequence ?? null, lastHeartbeatAckAt: gateway.heartbeatAckAt ?? null },
			jobs: {
				active: operationalTotal,
				suspectedStalled: jobs.filter((job) => job.activityHealth.value === "suspected_stalled").length,
				needsReview: historicalAttention.recoveryReview,
				...(operationalOverflow > 0 ? { operationalOverflow } : {}),
			},
		};
		return { status, jobs, historicalAttention };
	}

	getServiceOwner() {
		const service = this.db.prepare("SELECT generation, pid, boot_id, process_start_identity FROM service_state WHERE id = 1").get();
		if (!service?.pid) return null;
		return { generation: service.generation, pid: service.pid, bootId: service.boot_id, processStartIdentity: service.process_start_identity };
	}

	listJobs({ nowMs = Date.now(), serviceHealth, limit = DEFAULT_JOB_PAGE_SIZE, lifecycles = null } = {}) {
		jobPageLimit(limit);
		const health = serviceHealth ?? projectServiceHealth(this.db.prepare("SELECT * FROM service_state WHERE id = 1").get(), nowMs);
		let rows;
		if (lifecycles === null) rows = this.db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?").all(limit);
		else {
			if (!Array.isArray(lifecycles) || lifecycles.length < 1 || lifecycles.some((item) => !LIFECYCLES.has(item))) throw new Error("job lifecycle filter is invalid");
			const selected = [...new Set(lifecycles)];
			rows = this.db.prepare(`SELECT * FROM jobs WHERE lifecycle IN (${selected.map(() => "?").join(", ")}) ORDER BY updated_at DESC LIMIT ?`).all(...selected, limit);
		}
		return rows.map((job) => this.#projectJob(job, health, nowMs, false));
	}

	listOperationalJobs({ nowMs = Date.now(), serviceHealth, limit = DEFAULT_OPERATIONAL_JOB_LIMIT } = {}) {
		jobPageLimit(limit);
		const health = serviceHealth ?? projectServiceHealth(this.db.prepare("SELECT * FROM service_state WHERE id = 1").get(), nowMs);
		return this.db.prepare(`SELECT * FROM jobs WHERE ${OPERATIONAL_LIFECYCLE_PREDICATE} ORDER BY updated_at ASC LIMIT ?`).all(limit)
			.map((job) => this.#projectJob(job, health, nowMs, false, false));
	}

	operationalJobCount() {
		return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE ${OPERATIONAL_LIFECYCLE_PREDICATE}`).get().count ?? 0);
	}

	historicalAttentionCounts() {
		const row = this.db.prepare(`
			SELECT
				(SELECT COUNT(*) FROM jobs WHERE lifecycle = 'recovery_review') AS recovery_review,
				(SELECT COUNT(*) FROM jobs
					WHERE lifecycle IN ('completed', 'failed', 'cancelled', 'recovery_review')
						AND delivery_state IN ('unknown', 'failed')) AS delivery_issues
		`).get();
		return Object.freeze({ recoveryReview: Number(row.recovery_review ?? 0), deliveryIssues: Number(row.delivery_issues ?? 0) });
	}

	listJobsForScope(scopeKey, options = {}) {
		safeIdentifier(scopeKey, "scopeKey");
		const limit = jobPageLimit(options.limit ?? 32);
		const nowMs = options.nowMs ?? Date.now();
		const health = options.serviceHealth ?? projectServiceHealth(this.db.prepare("SELECT * FROM service_state WHERE id = 1").get(), nowMs);
		return this.db.prepare("SELECT * FROM jobs WHERE scope_key = ? ORDER BY updated_at DESC LIMIT ?").all(scopeKey, limit).map((job) => this.#projectJob(job, health, nowMs, false));
	}

	hasAcceptedIngressForJob(jobId) {
		safeIdentifier(jobId, "jobId");
		const row = this.db.prepare(`
			SELECT COUNT(*) AS accepted_count
			FROM ingress_messages AS ingress
			JOIN jobs AS job ON job.job_id = ingress.job_id AND job.scope_key = ingress.scope_key
			WHERE job.job_id = ? AND ingress.status = 'accepted' AND ingress.reason_code = 'authorized'
		`).get(jobId);
		return Number(row.accepted_count) === 1;
	}

	getJob(jobId, { nowMs = Date.now(), includeEvents = true } = {}) {
		const job = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
		if (!job) return null;
		const health = projectServiceHealth(this.db.prepare("SELECT * FROM service_state WHERE id = 1").get(), nowMs);
		return this.#projectJob(job, health, nowMs, includeEvents);
	}

	#projectJob(job, serviceHealth, nowMs, includeEvents, includeCompletion = true) {
		const childObservation = job.child_alive
			? observeOwnedProcess({ pid: job.child_pid, bootId: job.child_boot_id, processStartIdentity: job.child_start_identity })
			: { state: "not_expected", processAlive: false, reasonCode: "child_not_expected" };
		const healthJob = { ...job, child_alive: childObservation.state === "owned" ? 1 : 0, child_observation: childObservation };
		const checks = includeCompletion ? this.db.prepare("SELECT * FROM required_checks WHERE job_id = ? ORDER BY check_id").all(job.job_id) : [];
		const evidence = includeCompletion ? this.db.prepare("SELECT * FROM evidence WHERE job_id = ? ORDER BY observed_at").all(job.job_id).map((item) => ({ ...item, metrics: parseJson(item.metrics_json, {}) })) : [];
		const projected = {
			jobId: job.job_id, attemptId: job.attempt_id, lifecycle: job.lifecycle,
			activityHealth: projectActivityHealth(healthJob, serviceHealth, nowMs), backendId: job.backend_id,
			scopeKey: job.scope_key, revision: job.revision,
			acceptingServiceGeneration: job.accepting_service_generation ?? null,
			executingServiceGeneration: job.executing_service_generation ?? null,
			executionBinding: job.execution_binding_json === null || job.execution_binding_json === undefined ? null : validateDurableExecutionBinding(parseJson(job.execution_binding_json, null)),
			backendCapabilities: parseJson(job.backend_capabilities_json, {}), activityDetail: job.activity_detail,
			safeSummary: job.safe_summary, acceptedAt: job.accepted_at, startedAt: job.started_at,
			updatedAt: job.updated_at, lastProgressAt: job.last_progress_at, softSilenceMs: job.soft_silence_ms,
			hardDeadlineAt: job.hard_deadline_at, currentActivity: job.current_activity, waitingReason: job.waiting_reason,
			childAlive: childObservation.state === "owned", childState: childObservation,
			deliveryState: job.delivery_state, recoveryState: job.recovery_state, latestSafeError: job.latest_safe_error,
			completionAssessment: projectCompletionAssessment(checks, evidence, job.revision, job.attempt_id),
			requiredChecks: checks.map((check) => ({ checkId: check.check_id, kind: check.kind, safeLabel: check.safe_label, required: Boolean(check.required), revision: check.revision, allowReuse: Boolean(check.allow_reuse) })),
			evidence,
		};
		if (includeEvents) projected.events = this.eventsAfter({ jobId: job.job_id });
		return projected;
	}
}
