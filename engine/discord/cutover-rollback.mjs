import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { messengerInstancePaths } from "./instance-paths.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";
import {
	atomicPrivateWrite,
	createManagedRuntimeArtifact,
	cutoverRegistrationState,
	gitObjectId,
	gitRuntimeTreeId,
	hashTree,
	registrationBinding,
	sha256,
	sourceRegistrationBinding,
	verifyManagedRuntimeArtifact,
} from "./cutover-managed-runtime.mjs";

export const CANARY_STOP_CRITERIA = Object.freeze([
	"discord_token_already_owned",
	"discord_token_lock_unavailable",
	"configuration_invalid",
	"context_invalid",
	"context_changed_restart_required",
	"credential_unavailable",
	"startup_or_runtime_failure",
	"gateway_connection_evidence_stale",
	"approval_ui_detected",
	"operator_response_missed",
	"operator_response_invalid",
	"supervisor_state_missing",
	"supervisor_state_invalid",
	"supervisor_state_stale",
	"supervisor_unhealthy",
	"managed_registration_invalid",
	"service_runtime_not_current",
	"candidate_runtime_mismatch",
	"canary_job_missing",
	"canary_admission_invalid",
	"canary_job_not_after_cutover",
	"canary_job_incomplete",
	"canary_execution_binding_invalid",
	"canary_failure_or_recovery_event",
	"recovery_review_required",
	"delivery_unconfirmed",
	"failure_status_invalid",
]);

const CONFIG_PROBE_SOURCE = "import { pathToFileURL } from 'node:url'; const [loader, config] = process.argv.slice(1); const module = await import(pathToFileURL(loader)); module.loadMessengerConfig(config);";

function unitQuote(value) {
	if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("rollback systemd value is unsafe");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderLegacyRollbackUnits({ paths, runtimePath, names, tokenFingerprint, nodePath = process.execPath, backendExecutables = {} }) {
	if (!/^[a-f0-9]{64}$/.test(tokenFingerprint ?? "")) throw new Error("rollback token fingerprint is invalid");
	if (typeof nodePath !== "string" || !isAbsolute(nodePath)) throw new Error("rollback Node executable is invalid");
	const servicePath = join(runtimePath, "helper/service.mjs");
	const supervisorPath = join(runtimePath, "helper/supervisor.mjs");
	for (const path of [servicePath, supervisorPath]) if (!existsSync(path)) throw new Error("legacy rollback runtime entrypoint is unavailable");
	const tokenLockPath = `%t/naia-discord-token-${tokenFingerprint}.lock`;
	const exec = ["/usr/bin/flock", "--no-fork", "--nonblock", "--conflict-exit-code", "78", tokenLockPath,
		"/usr/bin/flock", "--no-fork", "--nonblock", "--conflict-exit-code", "78", paths.lockPath,
		nodePath, servicePath, "--adk-root", paths.root, "--instance", paths.instance].map(unitQuote).join(" ");
	const backendEnvironment = Object.entries(backendExecutables).map(([backend, executable]) => {
		if (!new Set(["codex", "claude", "opencode", "grok"]).has(backend) || typeof executable !== "string" || !isAbsolute(executable)) throw new Error("rollback backend executable is invalid");
		return `Environment=${unitQuote(`NAIA_${backend.toUpperCase()}_EXECUTABLE=${resolve(executable)}`)}`;
	});
	const executablePath = [...new Set([dirname(resolve(nodePath)), ...Object.values(backendExecutables).map((executable) => dirname(resolve(executable))), "/usr/local/bin", "/usr/bin", "/bin"])].join(delimiter);
	const environment = [...backendEnvironment, `Environment=${unitQuote(`PATH=${executablePath}`)}`].join("\n");
	return Object.freeze({
		service: `[Unit]\nDescription=Naia ADK Discord sessions (${paths.instance})\nWants=network-online.target\nAfter=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=3\n\n[Service]\nType=simple\nExecStart=${exec}\n${environment}\nRestart=always\nRestartPreventExitStatus=78\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=default.target\n`,
		supervisorService: `[Unit]\nDescription=Naia ADK Discord independent health observer (${paths.instance})\n\n[Service]\nType=oneshot\nExecStart=${[nodePath, supervisorPath, "--adk-root", paths.root, "--instance", paths.instance].map(unitQuote).join(" ")}\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n`,
		supervisorTimer: `[Unit]\nDescription=Naia ADK Discord health observer timer (${paths.instance})\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nAccuracySec=1s\nPersistent=true\nUnit=${names.supervisorTimerName.replace("-supervisor.timer", "-supervisor.service")}\n\n[Install]\nWantedBy=timers.target\n`,
	});
}

function supportsManagedRollbackRuntime(runtimePath) {
	const servicePath = existsSync(join(runtimePath, "engine-lock.json"))
		? join(runtimePath, ".engine/engine/discord/service.mjs") : join(runtimePath, "helper/service.mjs");
	return existsSync(join(runtimePath, "helper/service-runtime.mjs"))
		&& existsSync(join(runtimePath, "helper/supervisor-entry.mjs"))
		&& readFileSync(servicePath, "utf8").includes('process.argv[2] === "--managed-preflight"');
}

function supportedDatabaseVersion(skillRoot) {
	const source = readFileSync(join(skillRoot, existsSync(join(skillRoot, "engine-lock.json")) ? ".engine/engine/discord/constants.mjs" : "helper/constants.mjs"), "utf8");
	const match = source.match(/export const DB_SCHEMA_VERSION = (\d+);/);
	if (!match) throw new Error("rollback runtime database contract is unavailable");
	return Number(match[1]);
}

function currentDatabaseVersion(databasePath) {
	if (!existsSync(databasePath)) return null;
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const row = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
		const value = Number(row?.value);
		if (!Number.isSafeInteger(value) || value < 1) throw new Error("Discord database schema evidence is unavailable");
		return value;
	} finally { database.close(); }
}

export function validateConfigWithRuntime({ runtimePath, configPath, nodePath = process.execPath, expectedReceipt = null }) {
	const loaderPath = join(runtimePath, "helper/discord-config.mjs");
	const loaderSha256 = sha256(readFileSync(loaderPath));
	const configSha256 = sha256(readFileSync(configPath));
	const receipt = Object.freeze({ schemaVersion: 1, loaderRelativePath: "helper/discord-config.mjs", loaderSha256, configSha256, result: "accepted" });
	if (expectedReceipt !== null && JSON.stringify(receipt) !== JSON.stringify(expectedReceipt)) throw new Error("rollback config validation receipt mismatch");
	const probe = spawnSync(nodePath, ["--input-type=module", "--eval", CONFIG_PROBE_SOURCE, loaderPath, configPath], {
		encoding: "utf8",
		timeout: 30_000,
			env: {
			PATH: process.env.PATH ?? "",
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			...(process.argv.some((argument) => argument.endsWith("discord-cutover-rollback.test.mjs")) && process.env.NAIA_DISCORD_TEST_SKIP_ACL === "cutover-rollback-only"
				? { NAIA_DISCORD_TEST_CONTRACT: "cutover-rollback-probe" }
				: {}),
		},
	});
	if (probe.status !== 0) throw new Error("rollback source runtime rejected the preserved config");
	return receipt;
}

function assertRollbackLedgerIdle(databasePath) {
	if (!existsSync(databasePath)) return;
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const row = database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE lifecycle NOT IN ('completed', 'failed', 'cancelled', 'recovery_review')").get();
		if (!Number.isSafeInteger(row?.count) || row.count < 0) throw new Error("Discord rollback ledger state is unavailable");
		if (row.count > 0) throw new Error("Discord rollback requires an idle ledger with no nonterminal jobs");
	} finally { database.close(); }
}


function readManifest(bundleDirectory) {
	const manifestPath = join(bundleDirectory, "manifest.json");
	assertOwnerOnly(bundleDirectory, "directory", "Discord rollback bundle");
	assertOwnerOnly(manifestPath, "file", "Discord rollback manifest");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	let createdAtValid = false;
	try { createdAtValid = typeof manifest?.createdAt === "string" && new Date(manifest.createdAt).toISOString() === manifest.createdAt; } catch {}
	let registrationStateValid = false;
	try { cutoverRegistrationState(manifest?.registrationState); registrationStateValid = true; } catch {}
	let sourceRegistrationValid = false;
	try { sourceRegistrationBinding(manifest?.sourceRegistration); sourceRegistrationValid = true; } catch {}
	const serviceUnitMatch = /^(naia-discord-sessions-[a-f0-9]{12})\.service$/.exec(manifest?.units?.serviceName ?? "");
	const unitNamesValid = serviceUnitMatch !== null
		&& manifest.units.supervisorServiceName === `${serviceUnitMatch[1]}-supervisor.service`
		&& manifest.units.supervisorTimerName === `${serviceUnitMatch[1]}-supervisor.timer`
		&& (manifest.units.mode === undefined || new Set(["managed_artifact", "legacy_compat"]).has(manifest.units.mode));
	const artifactDigestsValid = /^[a-f0-9]{64}$/.test(manifest?.artifacts?.configSha256 ?? "")
		&& /^[a-f0-9]{64}$/.test(manifest?.artifacts?.runtimeSha256 ?? "")
		&& Object.keys(manifest?.artifacts?.unitSha256 ?? {}).sort().join(",") === "service,supervisorService,supervisorTimer"
		&& Object.values(manifest.artifacts.unitSha256).every((value) => /^[a-f0-9]{64}$/.test(value));
	const canaryCriteriaValid = Array.isArray(manifest?.canaryStopCriteria)
		&& manifest.canaryStopCriteria.length === CANARY_STOP_CRITERIA.length
		&& manifest.canaryStopCriteria.every((value, index) => value === CANARY_STOP_CRITERIA[index]);
	const configValidationValid = manifest?.configValidation?.schemaVersion === 1
		&& manifest.configValidation.loaderRelativePath === "helper/discord-config.mjs"
		&& /^[a-f0-9]{64}$/.test(manifest.configValidation.loaderSha256 ?? "")
		&& /^[a-f0-9]{64}$/.test(manifest.configValidation.configSha256 ?? "")
		&& manifest.configValidation.result === "accepted";
	if (manifest?.schemaVersion !== 1 || manifest.bundleId !== basename(bundleDirectory)
		|| !/^[a-f0-9]{40}$/.test(manifest.sourceRevision ?? "") || !/^[a-f0-9]{40}$/.test(manifest.sourceRuntimeTreeId ?? "")
		|| !/^[a-f0-9]{40}$/.test(manifest.candidateRevision ?? "") || !/^[a-f0-9]{40}$/.test(manifest.candidateRuntimeTreeId ?? "")
			|| manifest.sourceRevision === manifest.candidateRevision
			|| !createdAtValid
			|| !Number.isSafeInteger(manifest.configSchemaVersion) || manifest.configSchemaVersion < 0 || manifest.configSchemaVersion > 1_000
			|| !Number.isSafeInteger(manifest.database?.rollbackRuntimeMaxSchemaVersion)
		|| manifest.database.rollbackRuntimeMaxSchemaVersion < 1
		|| (manifest.database.observedSchemaVersion !== null
			&& (!Number.isSafeInteger(manifest.database.observedSchemaVersion) || manifest.database.observedSchemaVersion < 1
				|| manifest.database.observedSchemaVersion > manifest.database.rollbackRuntimeMaxSchemaVersion))
		|| manifest.database.policy !== "preserve"
		|| !unitNamesValid || !artifactDigestsValid || !canaryCriteriaValid || !configValidationValid) throw new Error("Discord rollback manifest is invalid");
	if (!registrationStateValid || !sourceRegistrationValid) throw new Error("Discord rollback manifest is invalid");
	return manifest;
}

export function verifyCutoverRollbackBundle(bundleDirectory) {
	const root = realpathSync(resolve(bundleDirectory));
	const manifest = readManifest(root);
	const configPath = join(root, "config.rollback.json");
	const runtimePath = join(root, "runtime/manage-discord-sessions");
	const units = {
		service: join(root, "units/service.unit"),
		supervisorService: join(root, "units/supervisor.service"),
		supervisorTimer: join(root, "units/supervisor.timer"),
	};
	assertOwnerOnly(configPath, "file", "Discord rollback config");
	assertOwnerOnly(runtimePath, "directory", "Discord rollback runtime");
	for (const path of Object.values(units)) assertOwnerOnly(path, "file", "Discord rollback unit");
	const runtimeArtifact = verifyManagedRuntimeArtifact({ artifactDirectory: root, expectedRuntimePath: runtimePath, expectedRevision: manifest.sourceRevision, expectedRuntimeTreeId: manifest.sourceRuntimeTreeId, expectedRuntimeSha256: manifest.artifacts.runtimeSha256 });
	const configBytes = readFileSync(configPath);
	if (sha256(configBytes) !== manifest.artifacts.configSha256) throw new Error("rollback config digest mismatch");
	let config;
	try { config = JSON.parse(configBytes.toString("utf8")); }
	catch { throw new Error("rollback config is invalid"); }
	if (config?.schemaVersion !== manifest.configSchemaVersion) throw new Error("rollback config schema version mismatch");
	validateConfigWithRuntime({ runtimePath, configPath, expectedReceipt: manifest.configValidation });
	if (hashTree(runtimePath) !== manifest.artifacts.runtimeSha256) throw new Error("rollback runtime digest mismatch");
	const unitMode = manifest.units.mode ?? (manifest.sourceRegistration.kind === "managed_artifact" ? "managed_artifact" : "legacy_compat");
	for (const [key, path] of Object.entries(units)) {
		const digest = sha256(readFileSync(path));
		if (digest !== manifest.artifacts.unitSha256[key]
			|| (unitMode === "managed_artifact" && digest !== runtimeArtifact.manifest.units.sha256[key])) throw new Error("rollback unit digest mismatch");
	}
	return Object.freeze({ manifest, bundleDirectory: root, configPath, runtimePath, units });
}

export function validateCutoverBootstrap({ candidateRoot, targetRoot, candidateRevision, targetRevision }) {
	for (const [value, label] of [[candidateRoot, "candidateRoot"], [targetRoot, "targetRoot"]]) if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be absolute`);
	for (const [value, label] of [[candidateRevision, "candidateRevision"], [targetRevision, "targetRevision"]]) if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} is invalid`);
	if (realpathSync(candidateRoot) === realpathSync(targetRoot) || candidateRevision === targetRevision) throw new Error("cutover prepare must run from a separate candidate revision before the target workspace is upgraded");
	return Object.freeze({ candidateRevision, targetRevision });
}

export function createCutoverRollbackBundle({ adkRoot, instance = "default", backendExecutables = {}, tokenFingerprint, sourceConfigText, verifySourceSnapshot, nodePath = process.execPath, now = new Date(), sourceRevision, sourceRuntimeTreeId, candidateRevision, candidateRuntimeTreeId, registrationState, sourceRegistration = null }) {
	const paths = messengerInstancePaths(realpathSync(resolve(adkRoot)), instance);
	gitObjectId(sourceRevision, "rollback source revision");
	gitObjectId(sourceRuntimeTreeId, "rollback source runtime tree ID");
	gitObjectId(candidateRevision, "candidate revision");
	gitObjectId(candidateRuntimeTreeId, "candidate runtime tree ID");
	const priorRegistrationState = cutoverRegistrationState(registrationState);
	if (sourceRevision === candidateRevision) throw new Error("rollback source and candidate revisions must differ");
	if (gitRuntimeTreeId(paths.root, sourceRevision) !== sourceRuntimeTreeId) throw new Error("rollback source runtime tree ID does not match its revision");
	if (typeof sourceConfigText !== "string" || typeof verifySourceSnapshot !== "function") throw new Error("rollback source config snapshot is required");
	const configBytes = Buffer.from(sourceConfigText);
	const config = JSON.parse(configBytes.toString("utf8"));
	mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
	protectOwnerOnly(paths.stateDirectory, "directory", "Discord service state");
	const bundlesRoot = join(paths.stateDirectory, "rollback-bundles");
	mkdirSync(bundlesRoot, { recursive: true, mode: 0o700 });
	protectOwnerOnly(bundlesRoot, "directory", "Discord rollback bundles");
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const bundleId = `${timestamp}-${randomUUID()}`;
	const bundleDirectory = join(bundlesRoot, bundleId);
	mkdirSync(bundleDirectory, { mode: 0o700 });
	protectOwnerOnly(bundleDirectory, "directory", "Discord rollback bundle");
	try {
		mkdirSync(join(bundleDirectory, "units"), { mode: 0o700 });
		const runtimeArtifact = createManagedRuntimeArtifact({ adkRoot: paths.root, instance: paths.instance, sourceRevision, sourceRuntimeTreeId, tokenFingerprint, nodePath, backendExecutables, credentialProfiles: config.runtime?.credentialProfiles ?? [], homeDirectory: homedir(), artifactDirectory: bundleDirectory });
		const runtimePath = runtimeArtifact.runtimePath;
		const rollbackDatabaseVersion = supportedDatabaseVersion(runtimePath);
		const rollbackConfigPath = join(bundleDirectory, "config.rollback.json");
		atomicPrivateWrite(rollbackConfigPath, configBytes, "Discord rollback config");
		const configValidation = validateConfigWithRuntime({ runtimePath, configPath: rollbackConfigPath, nodePath });
		const databaseVersion = currentDatabaseVersion(paths.databasePath);
		if (databaseVersion !== null && databaseVersion > rollbackDatabaseVersion) throw new Error("rollback runtime cannot open the current Discord database schema");
		const service = runtimeArtifact.service;
		const supervisor = runtimeArtifact.supervisor;
			const managedUnitContent = { service: service.content, supervisorService: supervisor.serviceContent, supervisorTimer: supervisor.timerContent };
			const boundSourceRegistration = sourceRegistrationBinding(sourceRegistration ?? registrationBinding("managed_artifact", managedUnitContent));
			const legacyCompatibilityRequired = boundSourceRegistration.kind === "legacy_mutable" && !supportsManagedRollbackRuntime(runtimePath);
			const names = { serviceName: service.unitName, supervisorServiceName: supervisor.serviceName, supervisorTimerName: supervisor.timerName,
				mode: legacyCompatibilityRequired ? "legacy_compat" : "managed_artifact" };
			const unitContent = legacyCompatibilityRequired
				? renderLegacyRollbackUnits({ paths, runtimePath, names, tokenFingerprint, nodePath, backendExecutables })
				: managedUnitContent;
			atomicPrivateWrite(join(bundleDirectory, "units/service.unit"), unitContent.service, "Discord rollback service unit");
		atomicPrivateWrite(join(bundleDirectory, "units/supervisor.service"), unitContent.supervisorService, "Discord rollback supervisor unit");
		atomicPrivateWrite(join(bundleDirectory, "units/supervisor.timer"), unitContent.supervisorTimer, "Discord rollback supervisor timer");
		const manifest = {
			schemaVersion: 1,
			bundleId,
			instance: paths.instance,
			createdAt: now.toISOString(),
			sourceRevision,
			sourceRuntimeTreeId,
			candidateRevision,
			candidateRuntimeTreeId,
			configSchemaVersion: config.schemaVersion ?? null,
			configValidation,
			database: { observedSchemaVersion: databaseVersion, rollbackRuntimeMaxSchemaVersion: rollbackDatabaseVersion, policy: "preserve" },
				units: names,
				registrationState: priorRegistrationState,
				sourceRegistration: boundSourceRegistration,
			artifacts: {
				configSha256: sha256(configBytes),
				runtimeSha256: hashTree(runtimePath),
				unitSha256: Object.fromEntries(Object.entries(unitContent).map(([key, value]) => [key, sha256(Buffer.from(value))])),
			},
			canaryStopCriteria: CANARY_STOP_CRITERIA,
		};
			atomicPrivateWrite(join(bundleDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "Discord rollback manifest");
			const verified = verifyCutoverRollbackBundle(bundleDirectory);
			if (verifySourceSnapshot() !== true) throw new Error("Discord rollback source snapshot revalidation failed");
			atomicPrivateWrite(paths.activeRollbackPath, `${JSON.stringify({ schemaVersion: 1, bundleId })}\n`, "Discord active rollback pointer");
			return verified;
	} catch (error) {
		rmSync(bundleDirectory, { recursive: true, force: true });
		throw error;
	}
}

export function activeCutoverRollbackBundle({ adkRoot, instance = "default" }) {
	const paths = messengerInstancePaths(realpathSync(resolve(adkRoot)), instance);
	assertOwnerOnly(paths.activeRollbackPath, "file", "Discord active rollback pointer");
	const pointer = JSON.parse(readFileSync(paths.activeRollbackPath, "utf8"));
	if (pointer?.schemaVersion !== 1 || typeof pointer.bundleId !== "string" || !/^[A-Za-z0-9-]{20,80}$/.test(pointer.bundleId)) throw new Error("Discord active rollback pointer is invalid");
	const bundleDirectory = resolve(paths.stateDirectory, "rollback-bundles", pointer.bundleId);
	const child = relative(resolve(paths.stateDirectory, "rollback-bundles"), bundleDirectory);
	if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Discord rollback bundle escaped its state directory");
	const bundle = verifyCutoverRollbackBundle(bundleDirectory);
	if (bundle.manifest.instance !== paths.instance) throw new Error("rollback instance does not match");
	return bundle;
}

export function restoreCutoverRollbackBundle({ adkRoot, instance = "default", stopService, installUnits, startService }) {
	if (![stopService, installUnits, startService].every((callback) => typeof callback === "function")) throw new Error("rollback service callbacks are required");
	const paths = messengerInstancePaths(realpathSync(resolve(adkRoot)), instance);
	const bundle = activeCutoverRollbackBundle({ adkRoot: paths.root, instance: paths.instance });
	if (bundle.manifest.instance !== paths.instance) throw new Error("rollback instance does not match");
	const assertDatabaseCompatible = () => {
		const databaseVersion = currentDatabaseVersion(paths.databasePath);
		if (databaseVersion !== null && databaseVersion > bundle.manifest.database.rollbackRuntimeMaxSchemaVersion) throw new Error("rollback runtime cannot open the current Discord database schema");
	};
	// Refuse before stopping a healthy service when rollback is already unsafe.
	assertDatabaseCompatible();
	assertRollbackLedgerIdle(paths.databasePath);
	stopService(bundle.manifest.units);
	// SQLite schema compatibility is not recovery-policy compatibility. An old
	// router must never reinterpret a nonterminal v2 envelope under v1 authority.
	// Re-check after stop to close the preflight-to-stop race.
	assertDatabaseCompatible();
	assertRollbackLedgerIdle(paths.databasePath);
	atomicPrivateWrite(paths.configPath, readFileSync(bundle.configPath), "restored Discord config");
	installUnits({ names: bundle.manifest.units, content: {
		service: readFileSync(bundle.units.service, "utf8"),
		supervisorService: readFileSync(bundle.units.supervisorService, "utf8"),
		supervisorTimer: readFileSync(bundle.units.supervisorTimer, "utf8"),
	} });
	// Close the install callback window. After this final check, the managed
	// service must reacquire the instance kernel flock before it can run.
	assertDatabaseCompatible();
	assertRollbackLedgerIdle(paths.databasePath);
	startService(bundle.manifest.units, bundle.manifest.registrationState);
	return bundle.manifest;
}
