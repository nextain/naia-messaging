#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMessengerConfig } from "./discord-config.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";
import { SessionStore } from "./store.mjs";
import { gatewayEvidenceBoundSeconds, projectUnattendedHealth } from "./unattended-health.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";
import { DISCORD_SERVICE_FAILURE_REASONS } from "./constants.mjs";
import { verifyManagedRuntimeLaunch } from "./cutover-bundle.mjs";

function argumentsFor(argv) {
	const rootIndex = argv.indexOf("--adk-root");
	const instanceIndex = argv.indexOf("--instance");
	if (rootIndex < 0 || !argv[rootIndex + 1]) throw new Error("--adk-root is required");
	if (argv.includes("--loop")) throw new Error("interactive supervisor loops are unsupported; install the OS scheduler");
	return { adkRoot: resolve(argv[rootIndex + 1]), instance: normalizeMessengerInstance(instanceIndex < 0 ? "default" : argv[instanceIndex + 1]) };
}

function missingStatus(nowMs) {
	return { schemaVersion: 1, service: { state: "stopped", reasonCode: "service_state_missing" }, gateway: { lastHeartbeatAckAt: null }, jobs: { active: 0, suspectedStalled: 0, needsReview: 0 }, observedAt: new Date(nowMs).toISOString() };
}

function readStartupFailure(paths) {
	if (!existsSync(paths.serviceFailurePath)) return null;
	try {
		const stat = lstatSync(paths.serviceFailurePath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid");
		assertOwnerOnly(paths.serviceFailurePath, "file", "Discord service failure state");
		const value = JSON.parse(readFileSync(paths.serviceFailurePath, "utf8"));
		if (value?.schemaVersion !== 1 || !DISCORD_SERVICE_FAILURE_REASONS.has(value.reasonCode) || typeof value.observedAt !== "string" || new Date(value.observedAt).toISOString() !== value.observedAt) throw new Error("invalid");
		return value;
	} catch {
		return { schemaVersion: 1, reasonCode: "failure_status_invalid", observedAt: null };
	}
}

export function observeOnce({ adkRoot, instance = "default", nowMs = Date.now(), runtimeLaunch = "direct" }) {
	verifyManagedRuntimeLaunch({ environment: runtimeLaunch === "direct" ? { NAIA_DISCORD_LAUNCH_MODE: "direct" } : process.env, runtimePath: realpathSync(fileURLToPath(new URL("../../../", import.meta.url))), allowDirect: runtimeLaunch === "direct" });
	const paths = messengerInstancePaths(adkRoot, instance);
	const startupFailure = readStartupFailure(paths);
	let config = null;
	try { config = loadMessengerConfig(paths.configPath); }
	catch (error) { if (!startupFailure) throw error; }
	let store;
	let status;
	let jobs = [];
	let historicalAttention = { recoveryReview: 0, deliveryIssues: 0 };
	try {
		if (existsSync(paths.databasePath)) {
			store = SessionStore.openReadOnly(paths.databasePath);
			({ status, jobs, historicalAttention } = store.operationalSnapshot({ nowMs }));
		} else status = missingStatus(nowMs);
		if (startupFailure && status.service?.state !== "running") status = { ...status, service: { ...status.service, reasonCode: startupFailure.reasonCode } };
		const heartbeatSeconds = config?.runtime?.heartbeatSeconds ?? 10;
		const projection = projectUnattendedHealth({ status, jobs, historicalAttention, nowMs, noProgressInterventionSeconds: config?.runtime?.noProgressInterventionSeconds ?? config?.runtime?.softSilenceSeconds ?? 120, gatewayEvidenceStaleSeconds: gatewayEvidenceBoundSeconds(heartbeatSeconds) });
		mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
		protectOwnerOnly(paths.stateDirectory, "directory", "Discord supervisor state");
		const runtimeRevision = /^([a-f0-9]{40})\.[a-f0-9-]+$/.exec(status.service?.generation ?? "")?.[1] ?? null;
		const snapshot = { ...projection, instance: paths.instance, serviceGeneration: status.service?.generation ?? null, serviceRuntimeRevision: runtimeRevision, startupFailureReasonCode: startupFailure?.reasonCode ?? null };
		const temporary = `${paths.supervisorStatusPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: "wx" });
		protectOwnerOnly(temporary, "file", "Discord supervisor snapshot");
		renameSync(temporary, paths.supervisorStatusPath);
		protectOwnerOnly(paths.supervisorStatusPath, "file", "Discord supervisor snapshot");
		return snapshot;
	} finally { store?.close(); }
}

export function supervisorMain() {
	try {
		const options = argumentsFor(process.argv.slice(2));
		const runtimeLaunch = process.platform === "win32" && process.env.NAIA_DISCORD_LAUNCH_MODE === "direct" ? "direct" : "environment";
		const result = observeOnce({ ...options, runtimeLaunch });
		console.log(JSON.stringify(result));
		process.exitCode = result.state === "unhealthy" ? 4 : 0;
	} catch (error) {
		console.error(`naia-discord-supervisor: ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) supervisorMain();
