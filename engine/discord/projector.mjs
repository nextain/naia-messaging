import { DEFAULT_SERVICE_STALE_MS, TERMINAL_LIFECYCLES } from "./constants.mjs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { trustedWindowsSystemExecutable } from "./platform-security.mjs";

let cachedWindowsBootId;
const isolatedBackendRunnerContract =
	process.argv.some((argument) => argument.endsWith("backend-runner.test.mjs")) &&
	process.env.NAIA_DISCORD_TEST_SKIP_ACL === "backend-runner-only";

function windowsPowerShell(script, extraEnv = {}) {
	const result = spawnSync(trustedWindowsSystemExecutable("WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-Command", script,
	], {
		encoding: "utf8",
		windowsHide: true,
		env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ...extraEnv },
	});
	if (result.status !== 0) return null;
	return result.stdout.trim() || null;
}

function parseTime(value) {
	const timestamp = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(timestamp) ? timestamp : null;
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM" ? true : false;
	}
}

export function readBootId() {
	if (process.platform === "win32") {
		if (isolatedBackendRunnerContract) return "windows-test-boot";
		if (cachedWindowsBootId !== undefined) return cachedWindowsBootId;
		cachedWindowsBootId = windowsPowerShell(
			"(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks",
		);
		return cachedWindowsBootId;
	}
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
	} catch {
		return null;
	}
}

export function readProcessStartIdentity(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (process.platform === "win32") {
		if (isolatedBackendRunnerContract) {
			return processAlive(pid) ? `windows-test-process-${pid}` : null;
		}
		return windowsPowerShell(
			"$processId=[int]$env:NAIA_PROCESS_ID; $item=Get-Process -Id $processId -ErrorAction SilentlyContinue; if ($null -ne $item) { $item.StartTime.ToUniversalTime().Ticks }",
			{ NAIA_PROCESS_ID: String(pid) },
		);
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] ?? null;
	} catch {
		return null;
	}
}

export function observeOwnedProcess({ pid, bootId, processStartIdentity }) {
	const alive = processAlive(pid);
	if (alive === false) return { state: "missing", processAlive: false, reasonCode: "process_missing" };
	if (alive === null) return { state: "unknown", processAlive: null, reasonCode: "process_unobservable" };
	const currentBootId = readBootId();
	const currentStartIdentity = readProcessStartIdentity(pid);
	if (!bootId || !processStartIdentity || !currentBootId || !currentStartIdentity) {
		return { state: "unknown", processAlive: true, reasonCode: "ownership_evidence_missing" };
	}
	if (bootId !== currentBootId || processStartIdentity !== currentStartIdentity) {
		return { state: "conflict", processAlive: true, reasonCode: "ownership_conflict" };
	}
	return { state: "owned", processAlive: true, reasonCode: "owned_process_observed" };
}

export function projectServiceHealth(service, nowMs, staleAfterMs = DEFAULT_SERVICE_STALE_MS) {
	if (!service) {
		return {
			state: "stopped",
			reasonCode: "service_state_missing",
			observedAt: new Date(nowMs).toISOString(),
			heartbeatAt: null,
			processAlive: null,
		};
	}

	const heartbeatMs = parseTime(service.heartbeat_at);
	const heartbeatAgeMs = heartbeatMs === null ? null : nowMs - heartbeatMs;
	const ownership = observeOwnedProcess({ pid: service.pid, bootId: service.boot_id, processStartIdentity: service.process_start_identity });
	let state = "running";
	let reasonCode = "heartbeat_fresh_process_alive";

	if (service.status !== "running") {
		state = "stopped";
		reasonCode = "service_reported_stopped";
	} else if (ownership.state === "missing") {
		state = "stopped";
		reasonCode = "service_process_missing";
	} else if (ownership.state === "conflict") {
		state = "degraded";
		reasonCode = "ownership_conflict";
	} else if (ownership.state === "unknown") {
		state = "unknown";
		reasonCode = ownership.reasonCode;
	} else if (heartbeatAgeMs !== null && heartbeatAgeMs < 0) {
		state = "unknown";
		reasonCode = "clock_evidence_invalid";
	} else if (heartbeatAgeMs === null || heartbeatAgeMs > staleAfterMs) {
		state = "stale";
		reasonCode = "heartbeat_stale";
	}

	return {
		state,
		reasonCode,
		observedAt: new Date(nowMs).toISOString(),
		heartbeatAt: service.heartbeat_at,
		heartbeatAgeMs,
		processAlive: ownership.processAlive,
		generation: service.generation,
		bootId: service.boot_id,
	};
}

export function projectActivityHealth(job, serviceHealth, nowMs) {
	const observedAt = new Date(nowMs).toISOString();
	if (TERMINAL_LIFECYCLES.has(job.lifecycle)) {
		return { value: "not_applicable", reasonCode: `lifecycle_${job.lifecycle}`, observedAt, evidenceAt: job.updated_at };
	}
	if (serviceHealth.state !== "running") {
		return { value: "unknown", reasonCode: `service_${serviceHealth.state}`, observedAt, evidenceAt: serviceHealth.heartbeatAt };
	}
	if (job.lifecycle === "result_ready" || job.lifecycle === "delivering") {
		return { value: "waiting", reasonCode: `lifecycle_${job.lifecycle}`, observedAt, evidenceAt: job.updated_at };
	}
	if (job.lifecycle !== "queued" && job.child_observation?.state === "missing") {
		return { value: "unresponsive", reasonCode: "owned_child_missing", observedAt, evidenceAt: job.updated_at };
	}
	if (job.lifecycle !== "queued" && job.child_observation?.state === "conflict") {
		return { value: "unknown", reasonCode: "child_ownership_conflict", observedAt, evidenceAt: job.updated_at };
	}
	if (job.lifecycle !== "queued" && ["unknown", "not_expected"].includes(job.child_observation?.state)) {
		return { value: "unknown", reasonCode: job.child_observation?.reasonCode ?? "child_ownership_evidence_missing", observedAt, evidenceAt: job.updated_at };
	}
	if (job.lifecycle === "waiting_approval" || job.lifecycle === "retry_wait") {
		return { value: "waiting", reasonCode: `lifecycle_${job.lifecycle}`, observedAt, evidenceAt: job.updated_at };
	}
	if (job.lifecycle === "queued") {
		return { value: "waiting", reasonCode: "lifecycle_queued", observedAt, evidenceAt: job.updated_at };
	}

	const hardDeadlineMs = parseTime(job.hard_deadline_at);
	if (hardDeadlineMs !== null && nowMs >= hardDeadlineMs) {
		return { value: "unresponsive", reasonCode: "hard_deadline_exceeded", observedAt, evidenceAt: job.hard_deadline_at };
	}

	const lastActivityMs = parseTime(job.last_progress_at ?? job.updated_at);
	if (lastActivityMs === null) {
		return { value: "unknown", reasonCode: "activity_timestamp_missing", observedAt, evidenceAt: null };
	}
	if (lastActivityMs > nowMs) {
		return { value: "unknown", reasonCode: "clock_evidence_invalid", observedAt, evidenceAt: new Date(lastActivityMs).toISOString() };
	}
	const silenceDurationMs = Math.max(0, nowMs - lastActivityMs);
	if (silenceDurationMs > job.soft_silence_ms) {
		return { value: "suspected_stalled", reasonCode: "soft_silence_exceeded", observedAt, evidenceAt: new Date(lastActivityMs).toISOString(), silenceDurationMs };
	}
	if (!job.child_alive) {
		return { value: "unknown", reasonCode: "owned_child_not_observed", observedAt, evidenceAt: new Date(lastActivityMs).toISOString(), silenceDurationMs };
	}
	if (job.activity_detail === "unsupported") {
		return { value: "running_no_detail", reasonCode: "backend_detail_unsupported", observedAt, evidenceAt: new Date(lastActivityMs).toISOString(), silenceDurationMs };
	}
	return { value: "progressing", reasonCode: "recent_activity_event", observedAt, evidenceAt: new Date(lastActivityMs).toISOString(), silenceDurationMs };
}

export function projectCompletionAssessment(checks, evidence, revision, attemptId) {
	const trustedProducers = new Set(["host_verifier", "human_review"]);
	const required = checks.filter((item) => item.required === 1);
	const details = required.map((check) => {
		const candidates = evidence.filter((item) =>
			item.check_id === check.check_id
			&& trustedProducers.has(item.producer)
			&& (check.allow_reuse === 1 || (item.revision === revision && item.attempt_id === attemptId)));
		const latest = candidates.at(-1);
		return {
			checkId: check.check_id,
			safeLabel: check.safe_label,
			result: latest?.result ?? "missing",
			producer: latest?.producer ?? null,
			observedAt: latest?.observed_at ?? null,
		};
	});
	const passed = details.filter((item) => item.result === "passed").length;
	const failed = details.filter((item) => item.result === "failed").length;
	const missing = details.filter((item) => item.result === "missing").length;
	let assessment = "unverified";
	if (failed > 0) assessment = "failed";
	else if (missing > 0) assessment = "partial";
	else if (required.length > 0 && passed === required.length) assessment = "verified";
	return { assessment, required: required.length, passed, failed, missing, checks: details };
}
