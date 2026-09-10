import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { discordUnitIdentity, renderDiscordSupervisorUnits, renderDiscordUserUnit } from "./systemd.mjs";
import { FileCredentialResolver, loadMessengerConfig } from "./discord-config.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";
import { SessionStore } from "./store.mjs";
import {
	acquireDiscordArtifactOperationLock,
	activeCutoverRollbackBundle,
	createManagedRuntimeArtifact,
	verifyCutoverController,
	verifyLinuxLegacyRegistrationBinding,
	verifyLinuxManagedRegistration,
	verifyManagedRuntimeArtifact,
} from "./cutover-bundle.mjs";
import { discordTokenFingerprint } from "./token-owner-lock.mjs";
import { observeOwnedProcess } from "./projector.mjs";
import { installOperatorLauncher } from "./service-manager-launcher.mjs";
import { candidateControllerRoot, gitHeadRevision, installSupervisedPair, resolveBackendExecutable } from "./service-manager-shared.mjs";
import { inspectCutoverRuntimeTree } from "./service-cutover-controller.mjs";

function runSystemctl(args) {
	const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || "systemctl failed").trim());
	return result.stdout.trim();
}

export function installServiceCommands(unitName, autoStart = true) {
	if (typeof unitName !== "string" || !/^naia-discord-sessions-[a-f0-9]{12}\.service$/.test(unitName)) throw new Error("invalid Discord service unit name");
	if (typeof autoStart !== "boolean") throw new Error("invalid Discord service auto-start policy");
	return autoStart ? [["enable", unitName], ["restart", unitName]] : [["disable", "--now", unitName]];
}

export function installSupervisorTimerCommands(timerName) {
	if (typeof timerName !== "string" || !/^naia-discord-sessions-[a-f0-9]{12}-supervisor\.timer$/.test(timerName)) throw new Error("invalid Discord supervisor timer name");
	return [["enable", timerName], ["restart", timerName]];
}

export function authorizeManagedServiceInstall({ hasExistingRegistration, verifyCutoverUpgrade }) {
	if (typeof hasExistingRegistration !== "boolean") throw new Error("managed service installation state is invalid");
	if (!hasExistingRegistration) return "first_install";
	if (typeof verifyCutoverUpgrade !== "function") throw new Error("existing Discord service requires a verified cutover upgrade");
	try { verifyCutoverUpgrade(); }
	catch { throw new Error("existing Discord service requires a verified cutover upgrade"); }
	return "verified_cutover_upgrade";
}

function quarantineLinuxSupervisedPair(serviceName, supervisorTimerName) {
	const failures = [];
	for (const name of [serviceName, supervisorTimerName]) {
		try { runSystemctl(["disable", "--now", name]); }
		catch (error) { failures.push(error.message); }
	}
	if (failures.length) throw new Error(failures.join("; "));
}

export function removeUnreferencedManagedRuntimeArtifact(runtimeArtifact, serviceUnitPath) {
	if (!runtimeArtifact?.artifactDirectory || typeof serviceUnitPath !== "string") throw new Error("managed runtime cleanup input is invalid");
	if (existsSync(serviceUnitPath)) {
		const installed = readFileSync(serviceUnitPath, "utf8");
		if (installed.includes(`NAIA_DISCORD_RUNTIME_ARTIFACT=${runtimeArtifact.artifactDirectory}`)) return false;
	}
	verifyManagedRuntimeArtifact({ artifactDirectory: runtimeArtifact.artifactDirectory });
	const quarantinePath = `${runtimeArtifact.artifactDirectory}.install-failed`;
	if (existsSync(quarantinePath)) throw new Error("managed runtime cleanup quarantine already exists");
	renameSync(runtimeArtifact.artifactDirectory, quarantinePath);
	rmSync(quarantinePath, { recursive: true, force: false });
	return true;
}

function waitForLinuxInstallOwner({ readOwner, processObserver, expectedGeneration, attempts, intervalMs, wait }) {
	let previousOwnedTuple = null;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const owner = readOwner();
		const completeOwner = owner
			&& expectedGeneration.test(String(owner.generation))
			&& Number.isSafeInteger(owner.pid) && owner.pid > 0
			&& typeof owner.bootId === "string" && owner.bootId.length > 0
			&& typeof owner.processStartIdentity === "string" && owner.processStartIdentity.length > 0;
		const ownedTuple = completeOwner
			&& processObserver({ pid: owner.pid, bootId: owner.bootId, processStartIdentity: owner.processStartIdentity }).state === "owned"
			? JSON.stringify([owner.generation, owner.pid, owner.bootId, owner.processStartIdentity])
			: null;
		if (ownedTuple !== null && ownedTuple === previousOwnedTuple) return owner;
		previousOwnedTuple = ownedTuple;
		if (attempt + 1 < attempts) wait(intervalMs);
	}
	return null;
}

export function verifyLinuxInstallOutcome({ adkRoot, instance = "default", runtimeArtifact, autoStart, unitDirectory, stateReader, ownerReader, processObserver = observeOwnedProcess, readinessAttempts = 40, readinessIntervalMs = 250, wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds) } = {}) {
	if (!runtimeArtifact?.manifest || typeof autoStart !== "boolean") throw new Error("Discord Linux install verification input is invalid");
	if (!Number.isSafeInteger(readinessAttempts) || readinessAttempts < 1 || readinessAttempts > 300
		|| !Number.isSafeInteger(readinessIntervalMs) || readinessIntervalMs < 0 || readinessIntervalMs > 1_000
		|| typeof wait !== "function") throw new Error("Discord Linux install readiness policy is invalid");
	const verified = verifyLinuxManagedRegistration({
		adkRoot,
		instance,
		expectedRevision: runtimeArtifact.manifest.sourceRevision,
		expectedRuntimeTreeId: runtimeArtifact.manifest.sourceRuntimeTreeId,
		...(unitDirectory === undefined ? {} : { unitDirectory }),
		...(stateReader === undefined ? {} : { stateReader }),
		requireEnabledActive: autoStart,
		requireSupervisorActive: true,
	});
	if (!autoStart && (verified.state.service.enabled || verified.state.service.active)) throw new Error("disabled Discord service unexpectedly remained enabled or active");
	if (autoStart) {
		const readOwner = ownerReader ?? (() => {
			const paths = messengerInstancePaths(adkRoot, instance);
			if (!existsSync(paths.databasePath)) return null;
			const store = SessionStore.openReadOnly(paths.databasePath);
			try { return store.getServiceOwner(); }
			finally { store.close(); }
		});
		if (typeof readOwner !== "function" || typeof processObserver !== "function") throw new Error("Discord Linux process ownership verifier is invalid");
		const expectedGeneration = new RegExp(`^${runtimeArtifact.manifest.sourceRevision}\\.[a-f0-9-]+$`);
		if (!waitForLinuxInstallOwner({ readOwner, processObserver, expectedGeneration, attempts: readinessAttempts, intervalMs: readinessIntervalMs, wait })) {
			throw new Error("Discord managed service did not establish the expected owned running process");
		}
	}
	return verified;
}

export function manageLinuxService({ adkRoot, command, instance = "default" }) {
	const normalizedInstance = normalizeMessengerInstance(instance);
	const paths = messengerInstancePaths(adkRoot, normalizedInstance);
	const config = command === "install" || command === "unit" ? loadMessengerConfig(paths.configPath) : null;
	const backendExecutables = command === "install" ? { [config.backend.selected]: resolveBackendExecutable(config.backend.selected) } : {};
	const unitDirectory = resolve(homedir(), ".config/systemd/user");
	const unitIdentity = discordUnitIdentity(adkRoot, normalizedInstance);
	const unitBase = unitIdentity.unitName.slice(0, -".service".length);
	const installedNames = [unitIdentity.unitName, `${unitBase}-supervisor.service`, `${unitBase}-supervisor.timer`];
	const artifactOperation = command === "install" ? acquireDiscordArtifactOperationLock({ adkRoot, instance: normalizedInstance }) : null;
	try {
		if (command === "install") {
			let ownedStateExists = false;
			if (existsSync(paths.databasePath)) {
				const store = SessionStore.openReadOnly(paths.databasePath);
				try { ownedStateExists = store.getServiceOwner() !== null; }
				finally { store.close(); }
			}
			const registeredWithManager = installedNames.some((name) => {
				const result = spawnSync("systemctl", ["--user", "is-enabled", name], { encoding: "utf8", timeout: 5_000 });
				const state = result.stdout.trim();
				return state !== "" && state !== "not-found";
			});
			const hasExistingRegistration = ownedStateExists || registeredWithManager || installedNames.some((name) => existsSync(resolve(unitDirectory, name)));
			authorizeManagedServiceInstall({ hasExistingRegistration, verifyCutoverUpgrade: hasExistingRegistration ? () => {
				const bundle = verifyCutoverController(activeCutoverRollbackBundle({ adkRoot, instance: normalizedInstance }), candidateControllerRoot());
				const targetRevision = gitHeadRevision(adkRoot);
				const targetTreeId = inspectCutoverRuntimeTree(adkRoot, targetRevision);
				if (targetRevision !== bundle.manifest.candidateRevision || targetTreeId !== bundle.manifest.candidateRuntimeTreeId) throw new Error("cutover candidate is not deployed");
				if (bundle.manifest.sourceRegistration.kind === "legacy_mutable") {
					verifyLinuxLegacyRegistrationBinding({ adkRoot, instance: normalizedInstance, expectedUnitSha256: bundle.manifest.sourceRegistration.unitSha256 });
				} else {
					verifyLinuxManagedRegistration({ adkRoot, instance: normalizedInstance, expectedRevision: bundle.manifest.sourceRevision, expectedRuntimeTreeId: bundle.manifest.sourceRuntimeTreeId });
				}
			} : null });
		}
		const runtimeArtifact = command === "install" ? (() => {
			const runtimeRevision = gitHeadRevision(adkRoot);
			const runtimeTreeId = inspectCutoverRuntimeTree(adkRoot, runtimeRevision);
			return createManagedRuntimeArtifact({ adkRoot, instance: normalizedInstance, sourceRevision: runtimeRevision, sourceRuntimeTreeId: runtimeTreeId, tokenFingerprint: discordTokenFingerprint(new FileCredentialResolver(paths.credentialsDirectory).resolve(config.discord.credentialRef)), backendExecutables, credentialProfiles: config.runtime?.credentialProfiles ?? [], homeDirectory: homedir() });
		})() : null;
		const rendered = runtimeArtifact?.service ?? (command === "unit" ? (() => {
			const runtimeRevision = gitHeadRevision(adkRoot);
			inspectCutoverRuntimeTree(adkRoot, runtimeRevision);
			return renderDiscordUserUnit({ adkRoot, instance: normalizedInstance, tokenFingerprint: discordTokenFingerprint(new FileCredentialResolver(paths.credentialsDirectory).resolve(config.discord.credentialRef)), runtimeRevision, backendExecutables, credentialProfiles: config.runtime?.credentialProfiles ?? [], homeDirectory: homedir() });
		})() : { unitName: discordUnitIdentity(adkRoot, normalizedInstance).unitName });
		const supervisor = runtimeArtifact?.supervisor ?? renderDiscordSupervisorUnits({ adkRoot, instance: normalizedInstance });
		const unitPath = resolve(unitDirectory, rendered.unitName);
		if (command === "install") {
			let launcherPath = null;
			try {
				installSupervisedPair({
					installSupervisor: () => {
						mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
						chmodSync(paths.stateDirectory, 0o700);
						mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
						writeFileSync(unitPath, rendered.content, { mode: 0o600 });
						writeFileSync(resolve(unitDirectory, supervisor.serviceName), supervisor.serviceContent, { mode: 0o600 });
						writeFileSync(resolve(unitDirectory, supervisor.timerName), supervisor.timerContent, { mode: 0o600 });
						launcherPath = installOperatorLauncher(adkRoot, { probeInstance: normalizedInstance });
						runSystemctl(["daemon-reload"]);
						if (config.service?.startAt === "boot") {
							const linger = spawnSync("loginctl", ["enable-linger", userInfo().username], { encoding: "utf8" });
							if (linger.status !== 0) throw new Error((linger.stderr || linger.stdout || "could not enable user lingering").trim());
						}
						for (const args of installSupervisorTimerCommands(supervisor.timerName)) runSystemctl(args);
						return supervisor.timerName;
					},
					installService: () => {
						for (const args of installServiceCommands(rendered.unitName, config.service?.autoStart !== false)) runSystemctl(args);
						verifyLinuxInstallOutcome({ adkRoot, instance: normalizedInstance, runtimeArtifact, autoStart: config.service?.autoStart !== false });
						return rendered.unitName;
					},
					quarantinePair: () => quarantineLinuxSupervisedPair(rendered.unitName, supervisor.timerName),
				});
				return `installed ${rendered.unitName}, ${supervisor.timerName}, and ${launcherPath}`;
			} catch (error) {
				try { removeUnreferencedManagedRuntimeArtifact(runtimeArtifact, unitPath); }
				catch (cleanupError) { throw new Error(`${error.message}; managed runtime cleanup failed: ${cleanupError.message}`); }
				throw error;
			}
		}
		if (command === "status") {
			verifyLinuxManagedRegistration({ adkRoot, instance: normalizedInstance });
			return `${runSystemctl(["status", "--no-pager", rendered.unitName])}\n${runSystemctl(["status", "--no-pager", supervisor.timerName])}`;
		}
		if (new Set(["start", "stop", "restart", "enable", "disable"]).has(command)) {
			verifyLinuxManagedRegistration({ adkRoot, instance: normalizedInstance, requireSupervisorActive: new Set(["start", "restart", "enable"]).has(command) });
			runSystemctl([command, rendered.unitName]);
			return `${command} ${rendered.unitName}`;
		}
		if (command === "unit") return rendered.content;
		throw new Error(`unsupported service command: ${command}`);
	} finally { artifactOperation?.release(); }
}
