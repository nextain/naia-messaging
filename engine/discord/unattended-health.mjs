const TERMINAL = new Set(["completed", "failed", "cancelled", "recovery_review"]);

function timestamp(value) {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function issue(code, detail = {}) {
	return { code, ...detail };
}

export function gatewayEvidenceBoundSeconds(heartbeatSeconds = 10) {
	if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 1 || heartbeatSeconds > 60) throw new Error("heartbeatSeconds must be between 1 and 60");
	return Math.max(120, heartbeatSeconds * 3);
}

export function projectUnattendedHealth({ status, jobs = [], historicalAttention = null, nowMs = Date.now(), noProgressInterventionSeconds = 120, gatewayEvidenceStaleSeconds = 180 }) {
	if (!status || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("unattended health input is invalid");
	if (!Number.isSafeInteger(noProgressInterventionSeconds) || noProgressInterventionSeconds < 1 || noProgressInterventionSeconds > 3_600) throw new Error("no-progress bound is invalid");
	if (!Number.isSafeInteger(gatewayEvidenceStaleSeconds) || gatewayEvidenceStaleSeconds < 30 || gatewayEvidenceStaleSeconds > 300) throw new Error("Gateway evidence bound is invalid");
	const unhealthy = [];
	const attention = [];
	const boundMs = noProgressInterventionSeconds * 1_000;
	const serviceState = status.service?.state ?? "unknown";
	const operationalOverflow = status.jobs?.operationalOverflow ?? 0;
	if (!Number.isSafeInteger(operationalOverflow) || operationalOverflow < 0) throw new Error("operational job overflow is invalid");
	if (operationalOverflow > 0) unhealthy.push(issue("operational_jobs_truncated", { omittedJobs: operationalOverflow }));
	if (new Set(["stopped", "stale"]).has(serviceState)) unhealthy.push(issue(`service_${serviceState}`, { reasonCode: status.service?.reasonCode ?? null }));
	else if (serviceState !== "running") attention.push(issue(`service_${serviceState}`, { reasonCode: status.service?.reasonCode ?? null }));

	const gatewayAckMs = timestamp(status.gateway?.lastHeartbeatAckAt);
	const gatewayEvidence = gatewayAckMs === null || gatewayAckMs > nowMs ? "unknown" : nowMs - gatewayAckMs > gatewayEvidenceStaleSeconds * 1_000 ? "stale" : "heartbeat_ack";
	if (gatewayEvidence === "unknown") attention.push(issue("gateway_connection_evidence_unknown"));
	else if (gatewayEvidence === "stale") attention.push(issue("gateway_connection_evidence_stale", { observedAt: status.gateway.lastHeartbeatAckAt }));

	for (const job of jobs) {
		if (TERMINAL.has(job.lifecycle)) continue;
		if (job.lifecycle === "waiting_approval") {
			unhealthy.push(issue("approval_wait_forbidden", { jobId: job.jobId }));
			continue;
		}
		if (new Set(["retry_wait", "result_ready", "delivering"]).has(job.lifecycle)) {
			const waitingMs = timestamp(job.updatedAt);
			if (waitingMs === null || waitingMs > nowMs) attention.push(issue("work_clock_evidence_unknown", { jobId: job.jobId }));
			else if (nowMs - waitingMs > boundMs) unhealthy.push(issue("active_work_overdue", { jobId: job.jobId, lifecycle: job.lifecycle, evidenceAt: job.updatedAt, silenceMs: nowMs - waitingMs }));
			else attention.push(issue("active_work_waiting", { jobId: job.jobId, lifecycle: job.lifecycle }));
			continue;
		}
		if (job.lifecycle !== "queued" && job.lifecycle !== "running") {
			attention.push(issue("work_lifecycle_unknown", { jobId: job.jobId, lifecycle: job.lifecycle ?? null }));
			continue;
		}
		if (job.lifecycle === "running" && new Set(["missing", "conflict"]).has(job.childState?.state)) {
			unhealthy.push(issue(job.childState.state === "missing" ? "owned_child_missing" : "owned_child_conflict", { jobId: job.jobId }));
			continue;
		}
		if (job.lifecycle === "running" && job.childState?.state !== "owned") {
			attention.push(issue("owned_child_evidence_unknown", { jobId: job.jobId, childState: job.childState?.state ?? null }));
			continue;
		}
		const basis = job.lifecycle === "queued" ? job.acceptedAt : (job.lastProgressAt ?? job.startedAt);
		const basisMs = timestamp(basis);
		if (basisMs === null || basisMs > nowMs) {
			attention.push(issue("work_clock_evidence_unknown", { jobId: job.jobId }));
			continue;
		}
		if (nowMs - basisMs > boundMs) unhealthy.push(issue("active_work_overdue", { jobId: job.jobId, lifecycle: job.lifecycle, evidenceAt: basis, silenceMs: nowMs - basisMs }));
	}

	if (historicalAttention !== null && (typeof historicalAttention !== "object"
		|| !Number.isSafeInteger(historicalAttention.recoveryReview) || historicalAttention.recoveryReview < 0
		|| !Number.isSafeInteger(historicalAttention.deliveryIssues) || historicalAttention.deliveryIssues < 0)) throw new Error("historical attention counts are invalid");
	const historicalReview = historicalAttention?.recoveryReview ?? jobs.filter((job) => job.lifecycle === "recovery_review").length;
	const historicalDelivery = historicalAttention?.deliveryIssues ?? jobs.filter((job) => TERMINAL.has(job.lifecycle) && new Set(["unknown", "failed"]).has(job.deliveryState)).length;
	if (historicalReview > 0 || historicalDelivery > 0) attention.push(issue("historical_attention", { recoveryReview: historicalReview, deliveryIssues: historicalDelivery }));
	return {
		schemaVersion: 1,
		state: unhealthy.length ? "unhealthy" : attention.length ? "attention" : "healthy",
		observedAt: new Date(nowMs).toISOString(),
		foreignAgentSupervision: "unsupported",
		gatewayEvidence,
		unhealthy,
		attention,
	};
}
