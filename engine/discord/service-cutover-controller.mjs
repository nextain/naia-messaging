import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { FileCredentialResolver } from "./discord-config.mjs";
import { messengerInstancePaths } from "./instance-paths.mjs";
import { assertOwnerOnly } from "./platform-security.mjs";
import { observeOwnedProcess } from "./projector.mjs";
import { SessionStore } from "./store.mjs";
import {
	acquireDiscordArtifactOperationLock,
	activeCutoverRollbackBundle,
	createCutoverRollbackBundle,
	evaluateCutoverCanary,
	restoreCutoverRollbackBundle,
	validateCutoverBootstrap,
	verifyCutoverController,
	verifyLinuxLegacyRegistration,
	verifyLinuxManagedRegistration,
} from "./cutover-bundle.mjs";
import { discordTokenFingerprint } from "./token-owner-lock.mjs";
import { candidateControllerRoot, gitHeadRevision, resolveBackendExecutable } from "./service-manager-shared.mjs";

function runSystemctl(args) {
	const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || "systemctl failed").trim());
	return result.stdout.trim();
}

export function resolveCutoverBackendExecutables(name, resolver = resolveBackendExecutable) {
	if (!new Set(["codex", "claude", "opencode", "grok"]).has(name) || typeof resolver !== "function") throw new Error("cutover backend resolver input is invalid");
	try { return Object.freeze({ [name]: resolver(name) }); }
	catch { return Object.freeze({}); }
}

export function resolveManagedCutoverSource(installed, inspectSourceRuntimeTree) {
	const manifest = installed?.artifact?.manifest;
	if (!/^[a-f0-9]{40}$/.test(manifest?.sourceRevision ?? "")
		|| !/^[a-f0-9]{40}$/.test(manifest?.sourceRuntimeTreeId ?? "")
		|| typeof inspectSourceRuntimeTree !== "function") throw new Error("installed Discord managed source identity is invalid");
	const sourceRuntimeTreeId = inspectSourceRuntimeTree(manifest.sourceRevision);
	if (sourceRuntimeTreeId !== manifest.sourceRuntimeTreeId) throw new Error("installed Discord managed source tree is unavailable from the target repository");
	return Object.freeze({ sourceRevision: manifest.sourceRevision, sourceRuntimeTreeId });
}

export function prepareManagedDiscordCutover({ adkRoot, instance = "default" }) {
	if (process.platform === "win32") throw new Error("versioned Discord rollback bundles are not yet supported on Windows");
	const artifactOperation = acquireDiscordArtifactOperationLock({ adkRoot, instance });
	try {
		const paths = messengerInstancePaths(adkRoot, instance);
		const candidateRoot = candidateControllerRoot();
		const bootstrap = validateCutoverBootstrap({ candidateRoot, targetRoot: paths.root, candidateRevision: gitHeadRevision(candidateRoot), targetRevision: gitHeadRevision(paths.root) });
		const candidateRuntimeTreeId = inspectCutoverRuntimeTree(candidateRoot, bootstrap.candidateRevision);
		let sourceRevision = bootstrap.targetRevision;
		let sourceRuntimeTreeId = inspectCutoverRuntimeTree(paths.root, bootstrap.targetRevision);
		const sourceSnapshot = readCutoverSourceSnapshot(paths.configPath);
		const config = sourceSnapshot.config;
		const backendExecutables = resolveCutoverBackendExecutables(config.backend.selected);
		const tokenFingerprint = discordTokenFingerprint(new FileCredentialResolver(paths.credentialsDirectory).resolve(config.discord.credentialRef));
		const status = (mode, unit) => {
			const result = spawnSync("systemctl", ["--user", mode, unit], { encoding: "utf8", timeout: 5_000 });
			return result.stdout.trim();
		};
		let installed;
		try {
			installed = verifyLinuxManagedRegistration({ adkRoot, instance, stateReader: status });
			({ sourceRevision, sourceRuntimeTreeId } = resolveManagedCutoverSource(installed, (revision) => inspectCutoverRuntimeTree(paths.root, revision)));
		} catch (managedError) {
			try {
				installed = verifyLinuxLegacyRegistration({ adkRoot, instance, backend: config.backend.selected, stateReader: status });
			} catch (legacyError) {
				throw new Error(`Discord registration verification failed: managed: ${managedError.message}; legacy: ${legacyError.message}`);
			}
		}
		const registrationState = normalizeCutoverRegistrationState({
			serviceEnabled: status("is-enabled", installed.names.service),
			serviceActive: status("is-active", installed.names.service),
			supervisorTimerEnabled: status("is-enabled", installed.names.supervisorTimer),
			supervisorTimerActive: status("is-active", installed.names.supervisorTimer),
		});
		let serviceOwner = null;
		if (existsSync(paths.databasePath)) {
			const store = SessionStore.openReadOnly(paths.databasePath);
			try { serviceOwner = store.getServiceOwner(); }
			finally { store.close(); }
		}
		verifyCutoverSourceIdentity({
			sourceRevision,
			sourceRegistrationKind: installed.sourceRegistration?.kind ?? "managed_artifact",
			registrationState,
			serviceOwner,
			serviceUnit: installed.content.service,
			expectedServiceUnit: installed.content.service,
			supervisorServiceUnit: installed.content.supervisorService,
			expectedSupervisorServiceUnit: installed.content.supervisorService,
			supervisorTimerUnit: installed.content.supervisorTimer,
			expectedSupervisorTimerUnit: installed.content.supervisorTimer,
		});
		return createCutoverRollbackBundle({
			adkRoot,
			instance,
			backendExecutables,
			tokenFingerprint,
			sourceConfigText: sourceSnapshot.text,
			verifySourceSnapshot: () => verifyCutoverSourceSnapshot({
				configPath: paths.configPath,
				credentialsDirectory: paths.credentialsDirectory,
				expectedConfigText: sourceSnapshot.text,
				expectedTokenFingerprint: tokenFingerprint,
			}),
			sourceRevision,
			sourceRuntimeTreeId,
			candidateRevision: bootstrap.candidateRevision,
			candidateRuntimeTreeId,
			registrationState,
			sourceRegistration: installed.sourceRegistration ?? null,
		});
	} finally { artifactOperation.release(); }
}

export function verifyCutoverSourceIdentity({ sourceRevision, sourceRegistrationKind = "managed_artifact", registrationState, serviceOwner = null, serviceUnit = null, expectedServiceUnit, supervisorServiceUnit = null, expectedSupervisorServiceUnit, supervisorTimerUnit = null, expectedSupervisorTimerUnit }) {
	if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) throw new Error("cutover source revision is invalid");
	if (!new Set(["managed_artifact", "legacy_mutable"]).has(sourceRegistrationKind)) throw new Error("cutover source registration kind is invalid");
	if (typeof registrationState?.service?.enabled !== "boolean" || typeof registrationState?.service?.active !== "boolean"
		|| typeof registrationState?.supervisorTimer?.enabled !== "boolean" || typeof registrationState?.supervisorTimer?.active !== "boolean") throw new Error("cutover registration state is invalid");
	for (const [actual, expected, label] of [
		[serviceUnit, expectedServiceUnit, "service"],
		[supervisorServiceUnit, expectedSupervisorServiceUnit, "supervisor service"],
		[supervisorTimerUnit, expectedSupervisorTimerUnit, "supervisor timer"],
	]) {
		if (typeof expected !== "string") throw new Error(`expected Discord ${label} unit is invalid`);
		if (actual !== null && actual !== expected) throw new Error(`installed Discord ${label} runtime does not match the verified source registration`);
	}
	if ((registrationState.service.enabled || registrationState.service.active) && serviceUnit === null) throw new Error("registered Discord service unit is unavailable");
	if ((registrationState.supervisorTimer.enabled || registrationState.supervisorTimer.active) && (supervisorServiceUnit === null || supervisorTimerUnit === null)) throw new Error("registered Discord supervisor units are unavailable");
	if (registrationState.service.active) {
		const owned = serviceOwner && observeOwnedProcess({ pid: serviceOwner.pid, bootId: serviceOwner.bootId, processStartIdentity: serviceOwner.processStartIdentity }).state === "owned";
		const generationMatches = sourceRegistrationKind === "legacy_mutable"
			? typeof serviceOwner?.generation === "string" && serviceOwner.generation.length > 0
			: new RegExp(`^${sourceRevision}\\.[a-f0-9-]+$`).test(String(serviceOwner?.generation));
		if (!owned || !generationMatches) throw new Error("running Discord service runtime does not match the verified source registration");
	}
	return true;
}

export function readCutoverSourceConfig(configPath) {
	return readCutoverSourceSnapshot(configPath).config;
}

export function readCutoverSourceSnapshot(configPath) {
	assertOwnerOnly(configPath, "file", "Discord rollback source config");
	const before = lstatSync(configPath);
	const descriptor = openSync(configPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	let bytes;
	try {
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid || (opened.mode & 0o077) !== 0) throw new Error("Discord rollback source config changed while opening");
		bytes = readFileSync(descriptor);
		const after = fstatSync(descriptor);
		if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("Discord rollback source config changed while reading");
	} finally { closeSync(descriptor); }
	const text = bytes.toString("utf8");
	if (!Buffer.from(text).equals(bytes)) throw new Error("Discord rollback source config must be valid UTF-8");
	const config = JSON.parse(text);
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Discord rollback source config is invalid");
	if (!new Set(["codex", "claude", "opencode", "grok"]).has(config.backend?.selected)) throw new Error("Discord rollback source backend is invalid");
	if (typeof config.discord?.botUserId !== "string" || !/^\d{17,20}$/.test(config.discord.botUserId) || /^0+$/.test(config.discord.botUserId)) throw new Error("Discord rollback source bot user ID is invalid");
	if (typeof config.discord?.credentialRef !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(config.discord.credentialRef)) throw new Error("Discord rollback source credential reference is invalid");
	return Object.freeze({
		text,
		config: Object.freeze({ backend: Object.freeze({ selected: config.backend.selected }), discord: Object.freeze({ botUserId: config.discord.botUserId, credentialRef: config.discord.credentialRef }) }),
	});
}

export function verifyCutoverSourceSnapshot({ configPath, credentialsDirectory, expectedConfigText, expectedTokenFingerprint }) {
	if (typeof expectedConfigText !== "string" || !/^[a-f0-9]{64}$/.test(expectedTokenFingerprint ?? "")) throw new Error("Discord rollback source snapshot expectation is invalid");
	const current = readCutoverSourceSnapshot(configPath);
	if (current.text !== expectedConfigText) throw new Error("Discord rollback source config changed during prepare");
	const currentFingerprint = discordTokenFingerprint(new FileCredentialResolver(credentialsDirectory).resolve(current.config.discord.credentialRef));
	if (currentFingerprint !== expectedTokenFingerprint) throw new Error("Discord rollback source credential changed during prepare");
	return true;
}

export function normalizeCutoverRegistrationState(raw) {
	const enabled = (value, label) => {
		// systemd reports a service enabled through a target/timer relationship as
		// `indirect`; it is still an installed, startable registration.
		if (!new Set(["enabled", "indirect", "disabled", "not-found"]).has(value)) throw new Error(`${label} registration state is unavailable`);
		return value === "enabled" || value === "indirect";
	};
	const active = (value, label) => {
		if (!new Set(["active", "inactive", "failed", "not-found"]).has(value)) throw new Error(`${label} activity state is unavailable`);
		return value === "active";
	};
	return Object.freeze({
		service: Object.freeze({ enabled: enabled(raw?.serviceEnabled, "Discord service"), active: active(raw?.serviceActive, "Discord service") }),
		supervisorTimer: Object.freeze({ enabled: enabled(raw?.supervisorTimerEnabled, "Discord supervisor timer"), active: active(raw?.supervisorTimerActive, "Discord supervisor timer") }),
	});
}

export function cutoverRegistrationRestoreCommands(names, registrationState) {
	if (!names || !registrationState || typeof registrationState !== "object") throw new Error("rollback registration state is invalid");
	const commands = [["stop", names.serviceName], ["stop", names.supervisorTimerName]];
	for (const [unit, state] of [[names.supervisorTimerName, registrationState.supervisorTimer], [names.serviceName, registrationState.service]]) {
		if (typeof state?.enabled !== "boolean" || typeof state?.active !== "boolean") throw new Error("rollback registration state is invalid");
		commands.push([state.enabled ? "enable" : "disable", unit]);
		if (state.active) commands.push(["start", unit]);
	}
	return commands;
}

export function inspectCutoverRuntimeTree(root, revisionId) {
	if (typeof root !== "string" || !isAbsolute(root) || !/^[a-f0-9]{40}$/.test(revisionId ?? "")) throw new Error("cutover runtime tree input is invalid");
	const canonicalRoot = realpathSync(root);
	const status = spawnSync("git", ["-C", canonicalRoot, "status", "--porcelain=v1", "--untracked-files=all", "--", ".agents/skills/manage-discord-sessions"], { encoding: "utf8", timeout: 5_000 });
	if (status.status !== 0 || status.stdout.trim()) throw new Error("cutover requires clean candidate and target Discord runtime trees");
	const tree = spawnSync("git", ["-C", canonicalRoot, "rev-parse", `${revisionId}:.agents/skills/manage-discord-sessions`], { encoding: "utf8", timeout: 5_000 });
	if (tree.status !== 0 || !/^[a-f0-9]{40}$/.test(tree.stdout.trim())) throw new Error("cutover Discord runtime tree identity is unavailable");
	return tree.stdout.trim();
}

export function restoreManagedDiscordCutover({ adkRoot, instance = "default" }) {
	if (process.platform === "win32") throw new Error("versioned Discord rollback bundles are not yet supported on Windows");
	const artifactOperation = acquireDiscordArtifactOperationLock({ adkRoot, instance });
	try {
		verifyCutoverController(activeCutoverRollbackBundle({ adkRoot, instance }), candidateControllerRoot());
		const unitDirectory = resolve(homedir(), ".config/systemd/user");
		return restoreCutoverRollbackBundle({
			adkRoot,
			instance,
			stopService: (names) => runSystemctl(["stop", names.serviceName]),
			installUnits: ({ names, content }) => {
				mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
				writeFileSync(resolve(unitDirectory, names.serviceName), content.service, { mode: 0o600 });
				writeFileSync(resolve(unitDirectory, names.supervisorServiceName), content.supervisorService, { mode: 0o600 });
				writeFileSync(resolve(unitDirectory, names.supervisorTimerName), content.supervisorTimer, { mode: 0o600 });
				runSystemctl(["daemon-reload"]);
			},
			startService: (names, registrationState) => {
				for (const command of cutoverRegistrationRestoreCommands(names, registrationState)) runSystemctl(command);
			},
		});
	} finally { artifactOperation.release(); }
}

export function verifyManagedDiscordCutover({ adkRoot, instance = "default" }) {
	return verifyCutoverController(activeCutoverRollbackBundle({ adkRoot, instance }), candidateControllerRoot());
}

export function evaluateManagedDiscordCanary({ adkRoot, instance = "default", jobId }) {
	if (process.platform === "win32") throw new Error("versioned Discord cutover canaries are not yet supported on Windows");
	const candidateRoot = candidateControllerRoot();
	return evaluateCutoverCanary({ adkRoot, instance, jobId, candidateRoot, registrationVerifier: (input) => verifyLinuxManagedRegistration({ ...input, requireEnabledActive: true }) });
}
