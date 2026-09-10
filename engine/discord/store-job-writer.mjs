import { randomUUID } from "node:crypto";
import { ACTIVITY_DETAILS, DEFAULT_SOFT_SILENCE_MS } from "./constants.mjs";
import { projectServiceHealth } from "./projector.mjs";
import { buildSafeEventSummary, canonicalTimestamp, safeIdentifier, validateBackendCapabilities } from "./sanitize.mjs";
import { validateDurableExecutionBinding } from "./execution-profile.mjs";

function json(value) {
	return JSON.stringify(value ?? {});
}

export class SessionJobWriter {
	constructor(db, { eventWriter, hardenSidecars, readBootId, readProcessStartIdentity }) {
		this.db = db;
		this.events = eventWriter;
		this.hardenSidecars = hardenSidecars;
		this.readBootId = readBootId;
		this.readProcessStartIdentity = readProcessStartIdentity;
	}

	heartbeatService({ generation = randomUUID(), status = "running", pid = process.pid, now = new Date().toISOString() } = {}) {
		const bootId = this.readBootId();
		const processStartIdentity = this.readProcessStartIdentity(pid);
		safeIdentifier(generation, "generation");
		if (!new Set(["running", "stopped"]).has(status)) throw new Error("service status is not allowed");
		if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error("service pid must be a positive safe integer or null");
		canonicalTimestamp(now, "heartbeat time");
		if (status === "running" && (pid === null || bootId === null || processStartIdentity === null)) throw new Error("running service ownership evidence is required");
		if (bootId !== null) safeIdentifier(bootId, "bootId");
		if (processStartIdentity !== null) safeIdentifier(processStartIdentity, "processStartIdentity");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.db.prepare("SELECT * FROM service_state WHERE id = 1").get();
			if (existing) {
				const sameOwnerTuple = existing.pid === pid && existing.boot_id === bootId && existing.process_start_identity === processStartIdentity;
				const currentOwnerStartIdentity = this.readProcessStartIdentity(process.pid);
				const stoppingCurrentOwner = existing.generation === generation
					&& status === "stopped"
					&& pid === null
					&& existing.pid === process.pid
					&& bootId !== null
					&& existing.boot_id !== null
					&& existing.boot_id === bootId
					&& currentOwnerStartIdentity !== null
					&& existing.process_start_identity !== null
					&& existing.process_start_identity === currentOwnerStartIdentity;
				if (existing.generation === generation && !sameOwnerTuple && !stoppingCurrentOwner) throw new Error(`service ownership conflict within generation ${generation}`);
				if (existing.generation !== generation && existing.boot_id === bootId) {
					const existingHealth = projectServiceHealth(existing, Date.parse(now));
					if (!new Set(["stopped", "stale"]).has(existingHealth.state)) throw new Error(`service ownership conflict with generation ${existing.generation}`);
				}
			}
			this.db.prepare(`
				INSERT INTO service_state(id, generation, status, pid, started_at, heartbeat_at, boot_id, process_start_identity)
				VALUES(1, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, status = excluded.status,
					pid = excluded.pid, heartbeat_at = excluded.heartbeat_at, boot_id = excluded.boot_id,
					process_start_identity = excluded.process_start_identity
			`).run(generation, status, pid, now, now, bootId, processStartIdentity);
			this.db.exec("COMMIT");
			return generation;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}

	createJob({
		jobId = randomUUID(),
		backendId,
		revision = "unversioned",
		backendCapabilities = {},
		activityDetail = "unsupported",
		jobType = "unknown",
		scopeKey = null,
		now = new Date().toISOString(),
		softSilenceMs = DEFAULT_SOFT_SILENCE_MS,
		hardDeadlineAt = null,
		requiredChecks = [],
		recoveryEnvelope = null,
		executionBinding = null,
	}) {
		if (!backendId) throw new Error("backendId is required");
		safeIdentifier(jobId, "jobId");
		buildSafeEventSummary("attempt_started", { backend: backendId });
		safeIdentifier(revision, "revision");
		canonicalTimestamp(now, "job acceptance time");
		if (!Number.isSafeInteger(softSilenceMs) || softSilenceMs < 0) throw new Error("softSilenceMs must be a non-negative safe integer");
		if (hardDeadlineAt !== null) canonicalTimestamp(hardDeadlineAt, "hard deadline");
		if (!ACTIVITY_DETAILS.has(activityDetail)) throw new Error(`unsupported activity detail: ${activityDetail}`);
		const safeCapabilities = validateBackendCapabilities(backendCapabilities);
		const safeExecutionBinding = executionBinding === null ? null : validateDurableExecutionBinding(executionBinding);
		if (scopeKey !== null) safeIdentifier(scopeKey, "scopeKey");
		const summary = buildSafeEventSummary("job_accepted", { jobType });
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const acceptingGeneration = this.db.prepare("SELECT generation FROM service_state WHERE id = 1 AND status = 'running' AND pid IS NOT NULL").get()?.generation ?? null;
			if (acceptingGeneration !== null) safeIdentifier(acceptingGeneration, "accepting service generation");
			this.db.prepare(`
				INSERT INTO jobs(job_id, lifecycle, backend_id, revision, backend_capabilities_json, activity_detail,
					safe_summary, accepted_at, updated_at, soft_silence_ms, hard_deadline_at, scope_key, accepting_service_generation, execution_binding_json)
				VALUES(?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(jobId, backendId, revision, json(safeCapabilities), activityDetail, summary, now, now, softSilenceMs, hardDeadlineAt, scopeKey, acceptingGeneration, safeExecutionBinding === null ? null : JSON.stringify(safeExecutionBinding));
			for (const check of requiredChecks) {
				if (!check.checkId || !check.kind) throw new Error("required check needs checkId and kind");
				safeIdentifier(check.checkId, "checkId");
				if (!new Set(["requirement", "build", "test", "review"]).has(check.kind)) throw new Error(`unsupported required check kind: ${check.kind}`);
				const checkLabel = `${check.kind}:${check.checkId}`;
				this.db.prepare(`
					INSERT INTO required_checks(check_id, job_id, kind, safe_label, required, revision, allow_reuse)
					VALUES(?, ?, ?, ?, ?, ?, ?)
				`).run(check.checkId, jobId, check.kind, checkLabel, check.required === false ? 0 : 1, revision, check.allowReuse ? 1 : 0);
			}
			this.events.appendEvent({ jobId, dedupeKey: `job_accepted:${jobId}`, kind: "job_accepted", occurredAt: now, source: "gateway", safeSummary: summary });
			if (recoveryEnvelope) this.db.prepare("INSERT INTO job_recovery(job_id, iv, ciphertext, tag, updated_at) VALUES(?, ?, ?, ?, ?)").run(jobId, recoveryEnvelope.iv, recoveryEnvelope.ciphertext, recoveryEnvelope.tag, now);
			this.db.exec("COMMIT");
			this.hardenSidecars();
			return jobId;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}

	reserveAttempt(jobId, { attemptId = randomUUID(), now = new Date().toISOString(), backendId = null, replaceCurrent = false } = {}) {
		safeIdentifier(attemptId, "attemptId");
		canonicalTimestamp(now, "attempt reservation time");
		this.db.exec("BEGIN IMMEDIATE");
		try {
				const job = this.db.prepare("SELECT backend_id, attempt_id, child_alive FROM jobs WHERE job_id = ?").get(jobId);
				if (!job) throw new Error(`unknown job: ${jobId}`);
			if (backendId !== null && backendId !== job.backend_id) throw new Error(`job backend mismatch: expected ${job.backend_id}`);
				if ((job.attempt_id || job.child_alive) && !replaceCurrent) throw new Error("job already has an active attempt or reservation");
				if (replaceCurrent) this.db.prepare("UPDATE jobs SET child_alive = 0, child_pid = NULL, child_boot_id = NULL, child_start_identity = NULL WHERE job_id = ?").run(jobId);
				const executingGeneration = this.db.prepare("SELECT generation FROM service_state WHERE id = 1 AND status = 'running' AND pid IS NOT NULL").get()?.generation ?? null;
				if (executingGeneration !== null) safeIdentifier(executingGeneration, "executing service generation");
				this.events.appendEvent({ jobId, attemptId, dedupeKey: `attempt_reserved:${attemptId}`, kind: "attempt_reserved", occurredAt: now, source: "helper", safeSummary: buildSafeEventSummary("attempt_reserved", { backend: job.backend_id }) });
				this.db.prepare("UPDATE jobs SET executing_service_generation = ? WHERE job_id = ?").run(executingGeneration, jobId);
			this.db.exec("COMMIT");
			this.hardenSidecars();
			return attemptId;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}

	attachAttempt(jobId, {
		attemptId,
		now = new Date().toISOString(),
		childPid = process.pid,
		childBootId = this.readBootId(),
		childStartIdentity = this.readProcessStartIdentity(childPid),
		backendId = null,
	} = {}) {
		safeIdentifier(attemptId, "attemptId");
		canonicalTimestamp(now, "attempt start time");
		if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error("childPid must be a positive safe integer");
		if (childBootId === null || childStartIdentity === null) throw new Error("child ownership evidence is required");
		if (childBootId !== null) safeIdentifier(childBootId, "childBootId");
		if (childStartIdentity !== null) safeIdentifier(childStartIdentity, "childStartIdentity");
		this.db.exec("BEGIN IMMEDIATE");
		try {
				const job = this.db.prepare("SELECT backend_id, attempt_id, child_alive, executing_service_generation FROM jobs WHERE job_id = ?").get(jobId);
			if (!job) throw new Error(`unknown job: ${jobId}`);
			if (backendId !== null && backendId !== job.backend_id) throw new Error(`job backend mismatch: expected ${job.backend_id}`);
				if (job.attempt_id !== attemptId) throw new Error("attempt reservation ownership mismatch");
				if (job.child_alive) throw new Error("job already has an active attempt");
				const currentGeneration = this.db.prepare("SELECT generation FROM service_state WHERE id = 1 AND status = 'running' AND pid IS NOT NULL").get()?.generation ?? null;
				if (job.executing_service_generation !== currentGeneration) throw new Error("attempt service generation changed after reservation");
			this.events.appendEvent({ jobId, attemptId, dedupeKey: `attempt_started:${attemptId}`, kind: "attempt_started", occurredAt: now, source: "helper", safeSummary: buildSafeEventSummary("attempt_started", { backend: job.backend_id }) });
			this.db.prepare("UPDATE jobs SET child_pid = ?, child_boot_id = ?, child_start_identity = ? WHERE job_id = ?").run(childPid, childBootId, childStartIdentity, jobId);
			this.db.exec("COMMIT");
			this.hardenSidecars();
			return attemptId;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}

	startAttempt(jobId, { attemptId = randomUUID(), now = new Date().toISOString(), childPid = process.pid, backendId = null, replaceCurrent = false } = {}) {
		this.reserveAttempt(jobId, { attemptId, now, backendId, replaceCurrent });
		return this.attachAttempt(jobId, { attemptId, now, childPid, backendId });
	}

	failReservedAttempt(jobId, { attemptId, reasonCode = "internal_error", now = new Date().toISOString() } = {}) {
		return this.failAttempt(jobId, { attemptId, reasonCode, now, requireUnattached: true });
	}

	failAttempt(jobId, { attemptId, reasonCode = "internal_error", now = new Date().toISOString(), requireUnattached = false } = {}) {
		safeIdentifier(attemptId, "attemptId");
		canonicalTimestamp(now, "attempt failure time");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const job = this.db.prepare("SELECT attempt_id, child_alive FROM jobs WHERE job_id = ?").get(jobId);
			if (!job || job.attempt_id !== attemptId || (requireUnattached && job.child_alive)) throw new Error("attempt reservation ownership mismatch");
			this.events.appendEvent({ jobId, attemptId, kind: "failed", source: "helper", occurredAt: now, safeSummary: buildSafeEventSummary("failed", { reasonCode }) });
			this.db.prepare("UPDATE jobs SET attempt_id = NULL, child_alive = 0, child_pid = NULL, child_boot_id = NULL, child_start_identity = NULL WHERE job_id = ?").run(jobId);
			this.db.exec("COMMIT");
			this.hardenSidecars();
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch {}
			throw error;
		}
	}
}
