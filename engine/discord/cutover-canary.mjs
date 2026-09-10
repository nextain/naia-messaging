import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { messengerInstancePaths } from "./instance-paths.mjs";
import { assertOwnerOnly } from "./platform-security.mjs";
import { SessionStore } from "./store.mjs";
import { DISCORD_SERVICE_FAILURE_REASONS } from "./constants.mjs";
import { loadMessengerConfig } from "./discord-config.mjs";
import { buildAgentContextSnapshot } from "./agent-context.mjs";
import { recomputeDurableExecutionBinding, validateDurableExecutionBinding } from "./execution-profile.mjs";
import { inspectCutoverCandidateRuntime } from "./cutover-managed-runtime.mjs";
import { activeCutoverRollbackBundle } from "./cutover-rollback.mjs";

const CANARY_JOB_REVISION = "v2r";
const CANARY_FAILURE_OR_RECOVERY_EVENTS = new Set(["failed", "recovered", "recovery_review_required", "retry_scheduled", "watchdog_intervened", "cancel_requested", "cancelled"]);
const DEFAULT_SUPERVISOR_FRESH_MS = 130_000;

function verifyCurrentCanaryExecutionBinding(paths, storedBinding) {
	const expected = validateDurableExecutionBinding(storedBinding);
	const config = loadMessengerConfig(paths.configPath);
	if (config.schemaVersion !== 2 || expected.instance !== paths.instance) throw new Error("canary requires the current schema-v2 instance binding");
	const workspace = resolve(paths.root, config.workspace.path);
	const child = relative(paths.root, workspace);
	if (child.startsWith("..") || isAbsolute(child)) throw new Error("canary workspace escaped the ADK root");
	const snapshot = buildAgentContextSnapshot({ workspace, agentId: config.workspace.agentId, entrypoint: config.workspace.entrypoint, contextFiles: config.workspace.contextFiles });
	const current = recomputeDurableExecutionBinding({ config, instance: paths.instance, agentContextSnapshot: snapshot, storedBinding: expected });
	if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("canary execution binding is no longer current");
	return current;
}

export function verifyCutoverController(bundle, candidateRoot) {
	if (!bundle?.manifest) throw new Error("Discord rollback bundle is required");
	const candidate = inspectCutoverCandidateRuntime(candidateRoot);
	if (candidate.revision !== bundle.manifest.candidateRevision || candidate.runtimeTreeId !== bundle.manifest.candidateRuntimeTreeId) throw new Error("cutover controller does not match the prepared candidate");
	return bundle;
}

export function evaluateCutoverCanary({ adkRoot, instance = "default", jobId, candidateRoot, nowMs = Date.now(), supervisorFreshMs = DEFAULT_SUPERVISOR_FRESH_MS, registrationVerifier = null }) {
	if (typeof jobId !== "string" || jobId.length < 1 || jobId.length > 128 || /[\0\r\n]/.test(jobId)) throw new Error("canary job ID is invalid");
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("canary observation time is invalid");
	if (!Number.isSafeInteger(supervisorFreshMs) || supervisorFreshMs < 60_000 || supervisorFreshMs > 300_000) throw new Error("canary supervisor freshness bound is invalid");
	const paths = messengerInstancePaths(realpathSync(resolve(adkRoot)), instance);
	const bundle = activeCutoverRollbackBundle({ adkRoot: paths.root, instance: paths.instance });
	const reasons = [];
	try {
		const candidate = inspectCutoverCandidateRuntime(candidateRoot);
		const deployed = inspectCutoverCandidateRuntime(paths.root);
		if (candidate.root === deployed.root
			|| candidate.revision !== bundle.manifest.candidateRevision || candidate.runtimeTreeId !== bundle.manifest.candidateRuntimeTreeId
			|| deployed.revision !== bundle.manifest.candidateRevision || deployed.runtimeTreeId !== bundle.manifest.candidateRuntimeTreeId) reasons.push("candidate_runtime_mismatch");
	} catch { reasons.push("candidate_runtime_mismatch"); }
	let store = null;
	let canaryAcceptedAt = null;
	let canaryFinalAt = null;
	let currentServiceGeneration = null;
	try {
		if (!existsSync(paths.databasePath)) reasons.push("canary_job_missing", "service_runtime_not_current");
		else {
			store = SessionStore.openReadOnly(paths.databasePath);
				const job = store.getJob(jobId);
				const currentService = store.status({ nowMs }).service;
				currentServiceGeneration = currentService.generation ?? null;
				if (currentService.state !== "running" || !new RegExp(`^${bundle.manifest.candidateRevision}\\.[a-f0-9-]+$`).test(currentService.generation ?? "")) reasons.push("service_runtime_not_current");
				if (!job) reasons.push("canary_job_missing");
			else {
				const acceptedAt = Date.parse(job.acceptedAt);
				canaryAcceptedAt = Number.isFinite(acceptedAt) ? acceptedAt : null;
				const finalAt = Date.parse(job.updatedAt);
				canaryFinalAt = Number.isFinite(finalAt) ? finalAt : null;
				const preparedAt = Date.parse(bundle.manifest.createdAt);
					const expectedJobRevision = `${CANARY_JOB_REVISION}:${bundle.manifest.candidateRevision}`;
					if (!Number.isFinite(acceptedAt) || acceptedAt <= preparedAt || acceptedAt > nowMs || job.revision !== expectedJobRevision) reasons.push("canary_job_not_after_cutover");
					if (!store.hasAcceptedIngressForJob(jobId)) reasons.push("canary_admission_invalid");
					try { verifyCurrentCanaryExecutionBinding(paths, job.executionBinding); }
					catch { reasons.push("canary_execution_binding_invalid"); }
					if (typeof job.acceptingServiceGeneration !== "string" || job.acceptingServiceGeneration !== currentServiceGeneration
						|| job.executingServiceGeneration !== currentServiceGeneration) reasons.push("service_runtime_not_current");
				if (job.lifecycle !== "completed") reasons.push(job.lifecycle === "recovery_review" ? "recovery_review_required" : "canary_job_incomplete");
				if (job.deliveryState !== "delivered") reasons.push("delivery_unconfirmed");
				const sent = job.events.filter((event) => event.kind === "operator_response_sent").length;
				const missed = job.events.filter((event) => event.kind === "operator_response_missed").length;
				if (missed > 0) reasons.push("operator_response_missed");
				if (sent !== 1 || missed !== 0) reasons.push("operator_response_invalid");
				if (job.events.some((event) => event.kind === "approval_required"
					|| (event.kind === "failed" && event.safeSummary === "Job failed: approval_ui_detected"))) reasons.push("approval_ui_detected");
				if (job.events.some((event) => event.source === "recovery" || CANARY_FAILURE_OR_RECOVERY_EVENTS.has(event.kind))) reasons.push("canary_failure_or_recovery_event");
			}
		}
	} finally { store?.close(); }
	if (!existsSync(paths.supervisorStatusPath)) reasons.push("supervisor_state_missing");
	else {
		try {
			assertOwnerOnly(paths.supervisorStatusPath, "file", "Discord supervisor snapshot");
			const snapshot = JSON.parse(readFileSync(paths.supervisorStatusPath, "utf8"));
			if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.unhealthy) || !Array.isArray(snapshot.attention)
				|| snapshot.serviceRuntimeRevision !== bundle.manifest.candidateRevision || snapshot.serviceGeneration !== currentServiceGeneration) throw new Error("invalid");
			const observedAt = Date.parse(snapshot.observedAt);
			if (!Number.isFinite(observedAt)) throw new Error("invalid");
			if (observedAt < Date.parse(bundle.manifest.createdAt) || (canaryAcceptedAt !== null && observedAt < canaryAcceptedAt) || (canaryFinalAt !== null && observedAt < canaryFinalAt)
				|| observedAt > nowMs || nowMs - observedAt > supervisorFreshMs) reasons.push("supervisor_state_stale");
				const currentAttention = snapshot.attention.filter((item) => item?.code !== "historical_attention");
				const supervisorStateAcceptable = (snapshot.state === "healthy" && snapshot.attention.length === 0)
					|| (snapshot.state === "attention" && snapshot.attention.length > 0 && currentAttention.length === 0);
				if (snapshot.unhealthy.length !== 0 || !supervisorStateAcceptable) reasons.push("supervisor_unhealthy");
			if (snapshot.gatewayEvidence !== "heartbeat_ack") reasons.push("gateway_connection_evidence_stale");
			if (snapshot.startupFailureReasonCode !== null) {
				reasons.push(typeof snapshot.startupFailureReasonCode === "string" && DISCORD_SERVICE_FAILURE_REASONS.has(snapshot.startupFailureReasonCode) ? snapshot.startupFailureReasonCode : "failure_status_invalid");
			}
		} catch { reasons.push("supervisor_state_invalid"); }
		}
	if (registrationVerifier !== null) {
		try {
			if (typeof registrationVerifier !== "function") throw new Error("invalid");
			registrationVerifier({ adkRoot: paths.root, instance: paths.instance, expectedRevision: bundle.manifest.candidateRevision, expectedRuntimeTreeId: bundle.manifest.candidateRuntimeTreeId });
		} catch { reasons.push("managed_registration_invalid"); }
	}
	return Object.freeze({
		schemaVersion: 1,
		bundleId: bundle.manifest.bundleId,
		jobId,
		verdict: reasons.length ? "stop" : "continue",
		reasons: Object.freeze([...new Set(reasons)].sort()),
	});
}
