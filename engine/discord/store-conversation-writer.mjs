import { ACTIVITY_DETAILS, DEFAULT_SOFT_SILENCE_MS } from "./constants.mjs";
import { boundedSafeExcerpt, buildSafeEventSummary, canonicalTimestamp, safeIdentifier, validateBackendCapabilities } from "./sanitize.mjs";
import { validateDurableExecutionBinding } from "./execution-profile.mjs";

function json(value) {
	return JSON.stringify(value ?? {});
}

export class SessionConversationWriter {
	constructor(db, { eventWriter, hardenSidecars }) {
		this.db = db;
		this.events = eventWriter;
		this.hardenSidecars = hardenSidecars;
	}

	loadJobRecovery(jobId) {
		safeIdentifier(jobId, "jobId");
		const row = this.db.prepare("SELECT iv, ciphertext, tag FROM job_recovery WHERE job_id = ?").get(jobId);
		return row ? { iv: row.iv, ciphertext: row.ciphertext, tag: row.tag } : null;
	}

	deleteJobRecovery(jobId) {
		safeIdentifier(jobId, "jobId");
		const result = this.db.prepare("DELETE FROM job_recovery WHERE job_id = ?").run(jobId);
		this.hardenSidecars();
		return Number(result.changes);
	}

	loadGatewayState() {
		const row = this.db.prepare("SELECT * FROM gateway_state WHERE id = 1").get();
		return row ? { sessionId: row.session_id, resumeUrl: row.resume_url, sequence: row.sequence, heartbeatAckAt: row.heartbeat_ack_at, updatedAt: row.updated_at } : {};
	}

	saveGatewayState(patch, now = new Date().toISOString()) {
		canonicalTimestamp(now, "gateway state time");
		const current = this.loadGatewayState();
		const next = { ...current, ...patch };
		if (next.sequence !== null && next.sequence !== undefined && (!Number.isSafeInteger(next.sequence) || next.sequence < 0)) throw new Error("gateway sequence must be a non-negative safe integer");
		if (next.resumeUrl) {
			const url = new URL(next.resumeUrl);
			if (url.protocol !== "wss:" || !/(^|\.)discord\.gg$/.test(url.hostname)) throw new Error("unsafe gateway resume URL");
		}
		this.db.prepare(`INSERT INTO gateway_state(id, session_id, resume_url, sequence, heartbeat_ack_at, updated_at)
			VALUES(1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
			resume_url=excluded.resume_url, sequence=excluded.sequence, heartbeat_ack_at=excluded.heartbeat_ack_at, updated_at=excluded.updated_at`)
			.run(next.sessionId ?? null, next.resumeUrl ?? null, next.sequence ?? null, next.heartbeatAckAt ?? null, now);
	}

	clearGatewayResume(now = new Date().toISOString()) {
		this.saveGatewayState({ sessionId: null, resumeUrl: null, sequence: null }, now);
	}

	loadDiscordProjection(scopeKey) {
		safeIdentifier(scopeKey, "scopeKey");
		const row = this.db.prepare("SELECT * FROM discord_projections WHERE scope_key = ?").get(scopeKey);
		return row ? { scopeKey: row.scope_key, channelId: row.channel_id, messageId: row.message_id, updatedAt: row.updated_at } : null;
	}

	saveDiscordProjection({ scopeKey, channelId, messageId, now = new Date().toISOString() }) {
		for (const [value, label] of [[scopeKey, "scopeKey"], [channelId, "channelId"], [messageId, "messageId"]]) safeIdentifier(value, label);
		canonicalTimestamp(now, "projection time");
		this.db.prepare(`INSERT INTO discord_projections(scope_key, channel_id, message_id, updated_at) VALUES(?, ?, ?, ?)
			ON CONFLICT(scope_key) DO UPDATE SET channel_id=excluded.channel_id, message_id=excluded.message_id, updated_at=excluded.updated_at`).run(scopeKey, channelId, messageId, now);
	}

	reserveIngress({ sourceMessageId, scopeKey, status, jobId = null, reasonCode, dispatchSequence = null, now = new Date().toISOString() }) {
		safeIdentifier(sourceMessageId, "sourceMessageId");
		safeIdentifier(scopeKey, "scopeKey");
		if (!new Set(["accepted", "rejected", "handled"]).has(status)) throw new Error("unsupported ingress status");
		safeIdentifier(reasonCode, "reasonCode");
		canonicalTimestamp(now, "ingress time");
		if (dispatchSequence !== null && (!Number.isSafeInteger(dispatchSequence) || dispatchSequence < 0)) throw new Error("invalid dispatch sequence");
		this.db.exec("BEGIN IMMEDIATE");
			try {
				const existing = this.db.prepare("SELECT * FROM ingress_messages WHERE source_message_id = ?").get(sourceMessageId);
			if (existing) { this.db.exec("COMMIT"); return { duplicate: true, status: existing.status, jobId: existing.job_id }; }
			this.db.prepare(`INSERT INTO ingress_messages(source_message_id, scope_key, status, job_id, reason_code, dispatch_sequence, received_at, updated_at)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(sourceMessageId, scopeKey, status, jobId, reasonCode, dispatchSequence, now, now);
			this.db.exec("COMMIT");
			return { duplicate: false, status, jobId };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	acceptIngressAndCreateJob({ sourceMessageId, scopeKey, jobId, dispatchSequence = null, backendId, revision = "discord-v1", backendCapabilities = {}, activityDetail, jobType = "conversation", requestExcerpt = null, softSilenceMs = DEFAULT_SOFT_SILENCE_MS, recoveryEnvelope = null, executionBinding = null, now = new Date().toISOString() }) {
		for (const [value, label] of [[sourceMessageId, "sourceMessageId"], [scopeKey, "scopeKey"], [jobId, "jobId"], [backendId, "backendId"], [revision, "revision"]]) safeIdentifier(value, label);
		if (!/^\d{17,20}$/.test(sourceMessageId) || /^0+$/.test(sourceMessageId)) throw new Error("sourceMessageId must be a Discord snowflake");
		if (dispatchSequence !== null && (!Number.isSafeInteger(dispatchSequence) || dispatchSequence < 0)) throw new Error("invalid dispatch sequence");
		canonicalTimestamp(now, "ingress acceptance time");
		if (!Number.isSafeInteger(softSilenceMs) || softSilenceMs < 0) throw new Error("softSilenceMs must be a non-negative safe integer");
		if (!ACTIVITY_DETAILS.has(activityDetail)) throw new Error(`unsupported activity detail: ${activityDetail}`);
		buildSafeEventSummary("attempt_started", { backend: backendId });
		const safeCapabilities = validateBackendCapabilities(backendCapabilities);
		const safeExecutionBinding = executionBinding === null ? null : validateDurableExecutionBinding(executionBinding);
		const summary = buildSafeEventSummary("job_accepted", { jobType });
		const safeRequest = requestExcerpt === null ? null : boundedSafeExcerpt(requestExcerpt);
		if (recoveryEnvelope !== null) {
			for (const key of ["iv", "ciphertext", "tag"]) if (typeof recoveryEnvelope[key] !== "string" || !/^[A-Za-z0-9_-]+$/.test(recoveryEnvelope[key])) throw new Error("recovery envelope is invalid");
		}
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.db.prepare("SELECT * FROM ingress_messages WHERE source_message_id = ?").get(sourceMessageId);
			if (existing) {
				this.db.exec("COMMIT");
				return { duplicate: true, status: existing.status, jobId: existing.job_id };
			}
			this.db.prepare(`INSERT INTO ingress_messages(source_message_id, scope_key, status, job_id, reason_code, dispatch_sequence, received_at, updated_at)
				VALUES(?, ?, 'accepted', ?, 'authorized', ?, ?, ?)`).run(sourceMessageId, scopeKey, jobId, dispatchSequence, now, now);
			const acceptingGeneration = this.db.prepare("SELECT generation FROM service_state WHERE id = 1 AND status = 'running' AND pid IS NOT NULL").get()?.generation ?? null;
			if (acceptingGeneration !== null) safeIdentifier(acceptingGeneration, "accepting service generation");
			this.db.prepare(`INSERT INTO jobs(job_id, lifecycle, backend_id, revision, backend_capabilities_json, activity_detail,
				safe_summary, accepted_at, updated_at, soft_silence_ms, scope_key, accepting_service_generation, execution_binding_json)
				VALUES(?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(jobId, backendId, revision, json(safeCapabilities), activityDetail, summary, now, now, softSilenceMs, scopeKey, acceptingGeneration, safeExecutionBinding === null ? null : JSON.stringify(safeExecutionBinding));
			this.events.appendEvent({ jobId, dedupeKey: `job_accepted:${jobId}`, kind: "job_accepted", occurredAt: now, source: "gateway", safeSummary: summary });
			if (safeRequest) this.events.appendEvent({ jobId, dedupeKey: `request_recorded:${jobId}`, kind: "request_recorded", occurredAt: now, source: "gateway", safeSummary: buildSafeEventSummary("request_recorded", { excerpt: safeRequest.excerpt }), metrics: { truncated: safeRequest.truncated }, redactionLevel: "local_safe" });
			if (recoveryEnvelope) this.db.prepare("INSERT INTO job_recovery(job_id, iv, ciphertext, tag, updated_at) VALUES(?, ?, ?, ?, ?)").run(jobId, recoveryEnvelope.iv, recoveryEnvelope.ciphertext, recoveryEnvelope.tag, now);
			this.db.exec("COMMIT");
			this.hardenSidecars();
			return { duplicate: false, status: "accepted", jobId };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	reserveDelivery({ deliveryKey, jobId, attemptId, nonce, channelId, now = new Date().toISOString() }) {
		for (const [value, label] of [[deliveryKey, "deliveryKey"], [attemptId, "attemptId"], [nonce, "nonce"], [channelId, "channelId"]]) safeIdentifier(value, label);
		canonicalTimestamp(now, "delivery start time");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.db.prepare("SELECT * FROM delivery_attempts WHERE job_id = ? AND attempt_id = ?").get(jobId, attemptId);
			if (existing) {
				if (existing.channel_id !== channelId) throw new Error("delivery destination mismatch");
				if (existing.status === "started") {
					this.db.prepare("UPDATE delivery_attempts SET status = 'unknown', updated_at = ? WHERE delivery_key = ?").run(now, existing.delivery_key);
					this.events.appendEvent({ jobId, attemptId, kind: "delivery_unknown", source: "recovery", occurredAt: now, safeSummary: buildSafeEventSummary("delivery_unknown", { reasonCode: "recovery_interrupted" }) });
					existing.status = "unknown";
				}
				this.db.exec("COMMIT");
				return { existing: true, deliveryKey: existing.delivery_key, nonce: existing.nonce, channelId: existing.channel_id, status: existing.status };
			}
			this.db.prepare(`INSERT INTO delivery_attempts(delivery_key, job_id, attempt_id, nonce, channel_id, status, started_at, updated_at)
				VALUES(?, ?, ?, ?, ?, 'started', ?, ?)`)
				.run(deliveryKey, jobId, attemptId, nonce, channelId, now, now);
			this.events.appendEvent({ jobId, attemptId, kind: "delivery_started", source: "helper", occurredAt: now, safeSummary: buildSafeEventSummary("delivery_started", {}) });
			this.db.exec("COMMIT");
			return { existing: false, deliveryKey, nonce, channelId, status: "started" };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	startDelivery(input) { return this.reserveDelivery(input); }

	finishDelivery({ deliveryKey, status, messageId = null, reasonCode = "internal_error", now = new Date().toISOString() }) {
		if (!new Set(["confirmed", "unknown", "failed"]).has(status)) throw new Error("unsupported delivery status");
		canonicalTimestamp(now, "delivery finish time");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const delivery = this.db.prepare("SELECT * FROM delivery_attempts WHERE delivery_key = ?").get(deliveryKey);
			if (!delivery) throw new Error("unknown delivery key");
			if (delivery.status !== "started") throw new Error("delivery is already finalized");
			this.db.prepare("UPDATE delivery_attempts SET status = ?, message_id = ?, updated_at = ? WHERE delivery_key = ?").run(status, messageId, now, deliveryKey);
			const kind = status === "confirmed" ? "delivery_confirmed" : status === "unknown" ? "delivery_unknown" : "delivery_failed";
			this.events.appendEvent({ jobId: delivery.job_id, attemptId: delivery.attempt_id, kind, source: "helper", occurredAt: now,
				safeSummary: buildSafeEventSummary(kind, status === "confirmed" ? {} : { reasonCode }) });
			this.db.exec("COMMIT");
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	recoverInterruptedWork({ now = new Date().toISOString() } = {}) {
		canonicalTimestamp(now, "recovery time");
		const recovered = [];
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const jobs = this.db.prepare("SELECT * FROM jobs WHERE lifecycle NOT IN ('completed', 'failed', 'cancelled', 'recovery_review') ORDER BY accepted_at").all();
			for (const job of jobs) {
				const started = this.db.prepare("SELECT * FROM delivery_attempts WHERE job_id = ? AND status = 'started'").all(job.job_id);
				if (started.length > 0) {
					for (const delivery of started) {
						this.db.prepare("UPDATE delivery_attempts SET status = 'unknown', updated_at = ? WHERE delivery_key = ?").run(now, delivery.delivery_key);
						this.events.appendEvent({ jobId: job.job_id, attemptId: delivery.attempt_id, kind: "delivery_unknown", source: "recovery", occurredAt: now, safeSummary: buildSafeEventSummary("delivery_unknown", { reasonCode: "recovery_interrupted" }) });
					}
				} else {
					const envelope = this.db.prepare("SELECT iv, ciphertext, tag FROM job_recovery WHERE job_id = ?").get(job.job_id);
					if (envelope) {
						this.events.appendEvent({ jobId: job.job_id, attemptId: job.attempt_id, kind: "recovered", source: "recovery", occurredAt: now, safeSummary: buildSafeEventSummary("recovered", { recoveryAction: "safe_retry" }) });
						this.db.prepare("UPDATE jobs SET attempt_id = NULL, child_alive = 0, child_pid = NULL, child_boot_id = NULL, child_start_identity = NULL, recovery_state = 'resuming' WHERE job_id = ?").run(job.job_id);
						recovered.push({ jobId: job.job_id, backendId: job.backend_id, envelope: { iv: envelope.iv, ciphertext: envelope.ciphertext, tag: envelope.tag } });
					} else {
						this.events.appendEvent({ jobId: job.job_id, attemptId: job.attempt_id, kind: "recovery_review_required", source: "recovery", occurredAt: now, safeSummary: buildSafeEventSummary("recovery_review_required", {}) });
					}
				}
			}
			this.db.exec("COMMIT");
			return recovered;
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}
}
