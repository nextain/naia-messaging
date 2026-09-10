import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { messengerInstancePaths } from "./instance-paths.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";
import { discordUnitIdentity, renderDiscordSupervisorUnits, renderDiscordUserUnit } from "./systemd.mjs";
import { installEngineSnapshot, verifyEngineSnapshot } from "../../runtime/engine-snapshot.mjs";

const RUNTIME_GIT_PATH = ".agents/skills/manage-discord-sessions";
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unitQuote(value) {
	if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("systemd value is unsafe");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function sourceRegistrationBinding(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| !new Set(["managed_artifact", "legacy_mutable"]).has(value.kind)
		|| Object.keys(value.unitSha256 ?? {}).sort().join(",") !== "service,supervisorService,supervisorTimer"
		|| Object.values(value.unitSha256).some((digest) => !/^[a-f0-9]{64}$/.test(digest))) throw new Error("Discord source registration binding is invalid");
	return Object.freeze({ kind: value.kind, unitSha256: Object.freeze({ ...value.unitSha256 }) });
}

export function registrationBinding(kind, content) {
	return sourceRegistrationBinding({ kind, unitSha256: Object.fromEntries(Object.entries(content).map(([key, value]) => [key, sha256(Buffer.from(value))])) });
}

export function atomicPrivateWrite(path, bytes, label) {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
	protectOwnerOnly(temporary, "file", label);
	renameSync(temporary, path);
	protectOwnerOnly(path, "file", label);
}

export function hashTree(root) {
	const hash = createHash("sha256");
	const visit = (directory, prefix = "") => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const path = join(directory, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error("rollback runtime must not contain symbolic links");
			if (stat.isDirectory()) visit(path, relativePath);
			else if (stat.isFile()) {
				const bytes = readFileSync(path);
				const mode = stat.mode & 0o111 ? "100755" : "100644";
				hash.update(`${mode}\0${relativePath}\0${bytes.length}\0`, "utf8");
				hash.update(bytes);
			} else throw new Error("rollback runtime contains an unsupported filesystem entry");
		}
	};
	visit(root);
	return hash.digest("hex");
}

function managedRuntimeManifest(artifactDirectory) {
	const root = realpathSync(resolve(artifactDirectory));
	const manifestPath = join(root, "runtime-artifact.json");
	const runtimePath = join(root, "runtime/manage-discord-sessions");
	assertOwnerOnly(root, "directory", "Discord managed runtime artifact");
	assertOwnerOnly(manifestPath, "file", "Discord managed runtime manifest");
	assertOwnerOnly(runtimePath, "directory", "Discord managed runtime");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const unitKeys = "service,supervisorService,supervisorTimer";
	if (manifest?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceRevision ?? "")
		|| !/^[a-f0-9]{40}$/.test(manifest.sourceRuntimeTreeId ?? "") || !/^[a-f0-9]{64}$/.test(manifest.runtimeSha256 ?? "")
		|| typeof manifest.instance !== "string" || Object.keys(manifest.units?.names ?? {}).sort().join(",") !== unitKeys
		|| Object.keys(manifest.units?.sha256 ?? {}).sort().join(",") !== unitKeys
		|| !/^naia-discord-sessions-[a-f0-9]{12}\.service$/.test(manifest.units.names.service ?? "")
		|| manifest.units.names.supervisorService !== manifest.units.names.service.replace(/\.service$/, "-supervisor.service")
		|| manifest.units.names.supervisorTimer !== manifest.units.names.service.replace(/\.service$/, "-supervisor.timer")
		|| Object.values(manifest.units.sha256).some((value) => !/^[a-f0-9]{64}$/.test(value))) throw new Error("Discord managed runtime manifest is invalid");
	if (hashTree(runtimePath) !== manifest.runtimeSha256) throw new Error("Discord managed runtime digest mismatch");
	return Object.freeze({ artifactDirectory: root, manifestPath, runtimePath, manifest });
}

export function verifyManagedRuntimeArtifact({ artifactDirectory, expectedRuntimePath = null, expectedRevision = null, expectedRuntimeTreeId = null, expectedRuntimeSha256 = null } = {}) {
	if (typeof artifactDirectory !== "string" || !isAbsolute(artifactDirectory)) throw new Error("Discord managed runtime artifact path is invalid");
	const artifact = managedRuntimeManifest(artifactDirectory);
	if (expectedRuntimePath !== null && realpathSync(expectedRuntimePath) !== artifact.runtimePath) throw new Error("Discord service is not executing its managed runtime artifact");
	if (expectedRevision !== null && artifact.manifest.sourceRevision !== expectedRevision) throw new Error("Discord managed runtime revision mismatch");
	if (expectedRuntimeTreeId !== null && artifact.manifest.sourceRuntimeTreeId !== expectedRuntimeTreeId) throw new Error("Discord managed runtime tree mismatch");
	if (expectedRuntimeSha256 !== null && artifact.manifest.runtimeSha256 !== expectedRuntimeSha256) throw new Error("Discord managed runtime digest marker mismatch");
	return artifact;
}

export function verifyManagedRuntimeLaunch({ environment = process.env, runtimePath, allowDirect = false } = {}) {
	const mode = environment.NAIA_DISCORD_LAUNCH_MODE;
	const markers = {
		artifactDirectory: environment.NAIA_DISCORD_RUNTIME_ARTIFACT,
		revision: environment.NAIA_DISCORD_RUNTIME_REVISION,
		runtimeTreeId: environment.NAIA_DISCORD_RUNTIME_TREE_ID,
		runtimeSha256: environment.NAIA_DISCORD_RUNTIME_SHA256,
	};
	if (mode === "direct") {
		if (!allowDirect || Object.values(markers).some((value) => value !== undefined)) throw new Error("direct Discord runtime launch markers are invalid");
		return null;
	}
	if (mode !== "managed-systemd" || Object.values(markers).some((value) => typeof value !== "string" || value.length === 0)) throw new Error("managed Discord runtime launch markers are missing");
	const artifact = verifyManagedRuntimeArtifact({ artifactDirectory: markers.artifactDirectory, expectedRuntimePath: runtimePath, expectedRevision: markers.revision, expectedRuntimeTreeId: markers.runtimeTreeId, expectedRuntimeSha256: markers.runtimeSha256 });
	return artifact.manifest.sourceRevision;
}

export function systemctlState(mode, unit) {
	const result = spawnSync("systemctl", ["--user", mode, unit], { encoding: "utf8", timeout: 5_000 });
	return result.stdout.trim();
}

export function verifyLinuxManagedRegistration({ adkRoot, instance = "default", expectedRevision = null, expectedRuntimeTreeId = null, unitDirectory = resolve(homedir(), ".config/systemd/user"), stateReader = systemctlState, requireEnabledActive = false, requireSupervisorActive = false } = {}) {
	if (typeof stateReader !== "function") throw new Error("Discord systemd state reader is invalid");
	const identity = discordUnitIdentity(adkRoot, instance);
	const base = identity.unitName.slice(0, -".service".length);
	const names = { service: identity.unitName, supervisorService: `${base}-supervisor.service`, supervisorTimer: `${base}-supervisor.timer` };
	const paths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, resolve(unitDirectory, name)]));
	for (const [key, path] of Object.entries(paths)) assertOwnerOnly(path, "file", `installed Discord ${key} unit`);
	const content = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")]));
	const marker = content.service.match(/^Environment="NAIA_DISCORD_RUNTIME_ARTIFACT=([^"\r\n]+)"$/m);
	if (!marker || /\\["\\]/.test(marker[1])) throw new Error("installed Discord service has no unambiguous managed runtime artifact");
	const artifact = verifyManagedRuntimeArtifact({ artifactDirectory: marker[1], expectedRevision, expectedRuntimeTreeId });
	for (const key of Object.keys(names)) {
		if (artifact.manifest.units.names[key] !== names[key] || sha256(Buffer.from(content[key])) !== artifact.manifest.units.sha256[key]) throw new Error("installed Discord unit identity or bytes do not match the managed runtime artifact");
	}
	const state = {
		service: { enabled: stateReader("is-enabled", names.service) === "enabled", active: stateReader("is-active", names.service) === "active" },
		supervisorTimer: { enabled: stateReader("is-enabled", names.supervisorTimer) === "enabled", active: stateReader("is-active", names.supervisorTimer) === "active" },
	};
	if (requireEnabledActive && (!state.service.enabled || !state.service.active || !state.supervisorTimer.enabled || !state.supervisorTimer.active)) throw new Error("Discord managed service and independent supervisor timer must be enabled and active");
	if (requireSupervisorActive && (!state.supervisorTimer.enabled || !state.supervisorTimer.active)) throw new Error("Discord independent supervisor timer must be enabled and active");
	return Object.freeze({ artifact, names: Object.freeze(names), paths: Object.freeze(paths), content: Object.freeze(content), state: Object.freeze({ service: Object.freeze(state.service), supervisorTimer: Object.freeze(state.supervisorTimer) }) });
}

function linuxRegistrationFiles(adkRoot, instance, unitDirectory) {
	const identity = discordUnitIdentity(adkRoot, instance);
	const base = identity.unitName.slice(0, -".service".length);
	const names = { service: identity.unitName, supervisorService: `${base}-supervisor.service`, supervisorTimer: `${base}-supervisor.timer` };
	const paths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, resolve(unitDirectory, name)]));
	for (const [key, path] of Object.entries(paths)) assertOwnerOnly(path, "file", `installed Discord ${key} unit`);
	const content = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")]));
	return { identity, names, paths, content };
}

function legacyServiceUnit({ root, instance, nodePath, backend, backendExecutable, restart }) {
	const paths = messengerInstancePaths(root, instance);
	const servicePath = resolve(root, ".agents/skills/manage-discord-sessions/helper/service.mjs");
	const exec = ["/usr/bin/flock", "--no-fork", "--nonblock", paths.lockPath, nodePath, servicePath, "--adk-root", root, "--instance", instance].map(unitQuote).join(" ");
	const executablePath = [...new Set([dirname(resolve(nodePath)), dirname(resolve(backendExecutable)), "/usr/local/bin", "/usr/bin", "/bin"])].join(delimiter);
	return `[Unit]\nDescription=Naia ADK Discord sessions (${instance})\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${exec}\nEnvironment=${unitQuote(`NAIA_${backend.toUpperCase()}_EXECUTABLE=${resolve(backendExecutable)}`)}\nEnvironment=${unitQuote(`PATH=${executablePath}`)}\nRestart=${restart}\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=default.target\n`;
}

function legacySupervisorUnits({ root, instance, nodePath, serviceName }) {
	const supervisorPath = resolve(root, ".agents/skills/manage-discord-sessions/helper/supervisor.mjs");
	const base = serviceName.slice(0, -".service".length);
	const supervisorServiceName = `${base}-supervisor.service`;
	const supervisorTimerName = `${base}-supervisor.timer`;
	const exec = [nodePath, supervisorPath, "--adk-root", root, "--instance", instance].map(unitQuote).join(" ");
	return {
		service: `[Unit]\nDescription=Naia ADK Discord independent health observer (${instance})\n\n[Service]\nType=oneshot\nExecStart=${exec}\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n`,
		timer: `[Unit]\nDescription=Naia ADK Discord health observer timer (${instance})\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nAccuracySec=1s\nPersistent=true\nUnit=${supervisorServiceName}\n\n[Install]\nWantedBy=timers.target\n`,
		supervisorServiceName,
		supervisorTimerName,
	};
}

export function verifyLinuxLegacyRegistration({ adkRoot, instance = "default", backend, unitDirectory = resolve(homedir(), ".config/systemd/user"), stateReader = systemctlState } = {}) {
	if (!new Set(["codex", "claude", "opencode", "grok"]).has(backend) || typeof stateReader !== "function") throw new Error("legacy Discord registration input is invalid");
	const registration = linuxRegistrationFiles(adkRoot, instance, unitDirectory);
	if (registration.content.service.includes("NAIA_DISCORD_RUNTIME_ARTIFACT=")) throw new Error("Discord registration is not a legacy mutable registration");
	const root = registration.identity.root;
	const instanceName = registration.identity.instance;
	const servicePath = resolve(root, ".agents/skills/manage-discord-sessions/helper/service.mjs");
	const lockPath = messengerInstancePaths(root, instanceName).lockPath;
	const execPattern = new RegExp(`^ExecStart=${escapeRegex(["/usr/bin/flock", "--no-fork", "--nonblock", lockPath].map(unitQuote).join(" "))} "([^"\\r\\n]+)" ${escapeRegex([servicePath, "--adk-root", root, "--instance", instanceName].map(unitQuote).join(" "))}$`, "m");
	const execMatch = registration.content.service.match(execPattern);
	if (!execMatch || !isAbsolute(execMatch[1])) throw new Error("legacy Discord service execution identity is invalid");
	const nodePath = realpathSync(execMatch[1]);
	if (nodePath !== execMatch[1]) throw new Error("legacy Discord Node executable is not canonical");
	const backendPattern = new RegExp(`^Environment="NAIA_${backend.toUpperCase()}_EXECUTABLE=([^"\\r\\n]+)"$`, "m");
	const backendMatch = registration.content.service.match(backendPattern);
	if (!backendMatch || !isAbsolute(backendMatch[1])) throw new Error("legacy Discord backend executable is invalid");
	const backendExecutable = realpathSync(backendMatch[1]);
	if (backendExecutable !== backendMatch[1]) throw new Error("legacy Discord backend executable is not canonical");
	const expectedServices = ["always", "on-failure"].map((restart) => legacyServiceUnit({ root, instance: instanceName, nodePath, backend, backendExecutable, restart }));
	if (!expectedServices.includes(registration.content.service)) throw new Error("legacy Discord service unit does not match a supported mutable registration");
	const expectedSupervisor = legacySupervisorUnits({ root, instance: instanceName, nodePath, serviceName: registration.names.service });
	if (expectedSupervisor.supervisorServiceName !== registration.names.supervisorService
		|| expectedSupervisor.supervisorTimerName !== registration.names.supervisorTimer
		|| expectedSupervisor.service !== registration.content.supervisorService
		|| expectedSupervisor.timer !== registration.content.supervisorTimer) throw new Error("legacy Discord supervisor units do not match a supported mutable registration");
	const state = {
		service: { enabled: stateReader("is-enabled", registration.names.service) === "enabled", active: stateReader("is-active", registration.names.service) === "active" },
		supervisorTimer: { enabled: stateReader("is-enabled", registration.names.supervisorTimer) === "enabled", active: stateReader("is-active", registration.names.supervisorTimer) === "active" },
	};
	return Object.freeze({ ...registration, state: Object.freeze({ service: Object.freeze(state.service), supervisorTimer: Object.freeze(state.supervisorTimer) }), sourceRegistration: registrationBinding("legacy_mutable", registration.content) });
}

export function verifyLinuxLegacyRegistrationBinding({ adkRoot, instance = "default", expectedUnitSha256, unitDirectory = resolve(homedir(), ".config/systemd/user") } = {}) {
	const expected = sourceRegistrationBinding({ kind: "legacy_mutable", unitSha256: expectedUnitSha256 });
	const registration = linuxRegistrationFiles(adkRoot, instance, unitDirectory);
	if (registration.content.service.includes("NAIA_DISCORD_RUNTIME_ARTIFACT=")) throw new Error("legacy Discord registration unexpectedly changed modes");
	const actual = registrationBinding("legacy_mutable", registration.content);
	if (JSON.stringify(actual.unitSha256) !== JSON.stringify(expected.unitSha256)) throw new Error("legacy Discord registration bytes changed after cutover prepare");
	return Object.freeze({ ...registration, sourceRegistration: actual });
}

function gitText(adkRoot, args, label) {
	const result = spawnSync("git", ["-C", adkRoot, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: MAX_GIT_OUTPUT_BYTES });
	if (result.status !== 0) throw new Error(`${label} is unavailable`);
	return result.stdout.trim();
}

export function gitObjectId(value, label) {
	if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

export function cutoverRegistrationState(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| Object.keys(value).sort().join(",") !== "service,supervisorTimer") throw new Error("rollback registration state is invalid");
	const normalized = {};
	for (const key of ["service", "supervisorTimer"]) {
		const state = value[key];
		if (!state || typeof state !== "object" || Array.isArray(state)
			|| Object.keys(state).sort().join(",") !== "active,enabled"
			|| typeof state.active !== "boolean" || typeof state.enabled !== "boolean") throw new Error("rollback registration state is invalid");
		normalized[key] = Object.freeze({ enabled: state.enabled, active: state.active });
	}
	return Object.freeze(normalized);
}

export function gitRuntimeTreeId(adkRoot, revision) {
	gitObjectId(revision, "Git revision");
	return gitObjectId(gitText(adkRoot, ["rev-parse", `${revision}:${RUNTIME_GIT_PATH}`], "Discord runtime Git tree ID"), "Discord runtime Git tree ID");
}

function materializeGitRuntime({ adkRoot, revision, expectedTreeId, runtimePath }) {
	const actualTreeId = gitRuntimeTreeId(adkRoot, revision);
	if (actualTreeId !== expectedTreeId) throw new Error("rollback source runtime tree ID does not match its revision");
	mkdirSync(runtimePath, { mode: 0o700 });
	protectOwnerOnly(runtimePath, "directory", "Discord rollback runtime");
	const archive = spawnSync("git", ["-C", adkRoot, "archive", "--format=tar", revision, RUNTIME_GIT_PATH], { timeout: 15_000, maxBuffer: MAX_GIT_OUTPUT_BYTES });
	if (archive.status !== 0 || !Buffer.isBuffer(archive.stdout)) throw new Error("rollback Git runtime archive is unavailable");
	const extracted = spawnSync("tar", ["-xf", "-", "--strip-components=3", "-C", runtimePath], { input: archive.stdout, timeout: 15_000, maxBuffer: MAX_GIT_OUTPUT_BYTES });
	if (extracted.status !== 0) throw new Error("rollback Git runtime archive could not be materialized");
	// Git for Windows can hand the external tar implementation text files with
	// checkout-style line endings. Rehydrate every regular file from its blob so
	// the managed runtime is byte-identical to the committed tree on every OS.
	const listing = spawnSync("git", ["-C", adkRoot, "ls-tree", "-r", "-z", revision, "--", RUNTIME_GIT_PATH], { timeout: 10_000, maxBuffer: MAX_GIT_OUTPUT_BYTES });
	if (listing.status !== 0 || !Buffer.isBuffer(listing.stdout)) throw new Error("rollback Git runtime file evidence is unavailable");
	const prefix = `${RUNTIME_GIT_PATH}/`;
	for (const record of listing.stdout.toString("utf8").split("\0").filter(Boolean)) {
		const match = record.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/);
		if (!match || !match[3].startsWith(prefix)) throw new Error("rollback Git runtime contains an unsupported entry");
		const target = join(runtimePath, match[3].slice(prefix.length));
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		const blob = spawnSync("git", ["-C", adkRoot, "cat-file", "blob", match[2]], { timeout: 5_000, maxBuffer: MAX_GIT_OUTPUT_BYTES });
		if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) throw new Error("rollback Git runtime blob is unavailable");
		writeFileSync(target, blob.stdout, { mode: match[1] === "100755" ? 0o755 : 0o644 });
	}
	verifyGitRuntimeBytes({ adkRoot, revision, runtimePath });
	const lockPath = join(runtimePath, "engine-lock.json");
	if (existsSync(lockPath)) {
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		let sourceRoot = join(adkRoot, RUNTIME_GIT_PATH, ".engine");
        try { verifyEngineSnapshot(sourceRoot, lock); }
        catch { sourceRoot = join(adkRoot, RUNTIME_GIT_PATH, ".engine-cache", lock.snapshotSha256); }
        installEngineSnapshot({ sourceRoot, destination: join(runtimePath, ".engine"), lock });
	}
	return actualTreeId;
}

function runtimeFiles(root) {
	const files = [];
	const visit = (directory, prefix = "") => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const path = join(directory, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error("rollback runtime must not contain symbolic links");
			if (stat.isDirectory()) visit(path, relativePath);
			else if (stat.isFile()) files.push({ path, relativePath, mode: stat.mode & 0o111 ? "100755" : "100644" });
			else throw new Error("rollback runtime contains an unsupported filesystem entry");
		}
	};
	visit(root);
	return files;
}

function verifyGitRuntimeBytes({ adkRoot, revision, runtimePath }) {
	const listing = spawnSync("git", ["-C", adkRoot, "ls-tree", "-r", "-z", revision, "--", RUNTIME_GIT_PATH], { timeout: 10_000, maxBuffer: MAX_GIT_OUTPUT_BYTES });
	if (listing.status !== 0 || !Buffer.isBuffer(listing.stdout)) throw new Error("rollback Git runtime file evidence is unavailable");
	const prefix = `${RUNTIME_GIT_PATH}/`;
	const expected = new Map();
	for (const record of listing.stdout.toString("utf8").split("\0").filter(Boolean)) {
		const match = record.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/);
		if (!match || !match[3].startsWith(prefix)) throw new Error("rollback Git runtime contains an unsupported entry");
		expected.set(match[3].slice(prefix.length), { mode: match[1], objectId: match[2] });
	}
	const actual = runtimeFiles(runtimePath);
	if (actual.length !== expected.size) throw new Error("rollback Git runtime materialization is incomplete");
	for (const file of actual) {
		const evidence = expected.get(file.relativePath);
		if (!evidence || evidence.mode !== file.mode) throw new Error("rollback Git runtime materialization mode mismatch");
		const object = spawnSync("git", ["-C", adkRoot, "hash-object", "--no-filters", "--stdin"], { input: readFileSync(file.path), encoding: "utf8", timeout: 5_000 });
		if (object.status !== 0 || object.stdout.trim() !== evidence.objectId) throw new Error("rollback Git runtime materialization byte mismatch");
	}
}

export function createManagedRuntimeArtifact({ adkRoot, instance = "default", sourceRevision, sourceRuntimeTreeId, tokenFingerprint, nodePath = process.execPath, backendExecutables = {}, credentialProfiles = [], homeDirectory = homedir(), artifactDirectory = null }) {
	const paths = messengerInstancePaths(realpathSync(resolve(adkRoot)), instance);
	gitObjectId(sourceRevision, "managed runtime source revision");
	gitObjectId(sourceRuntimeTreeId, "managed runtime source tree ID");
	if (gitRuntimeTreeId(paths.root, sourceRevision) !== sourceRuntimeTreeId) throw new Error("managed runtime source tree ID does not match its revision");
	let ownsArtifactDirectory = false;
	let root;
	if (artifactDirectory === null) {
		const artifactsRoot = join(paths.stateDirectory, "managed-runtimes");
		mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
		protectOwnerOnly(artifactsRoot, "directory", "Discord managed runtimes");
		root = join(artifactsRoot, `${sourceRevision}-${randomUUID()}`);
		mkdirSync(root, { mode: 0o700 });
		ownsArtifactDirectory = true;
	} else {
		if (typeof artifactDirectory !== "string" || !isAbsolute(artifactDirectory)) throw new Error("Discord managed runtime artifact path is invalid");
		root = realpathSync(artifactDirectory);
		assertOwnerOnly(root, "directory", "Discord managed runtime artifact");
	}
	try {
		const runtimePath = join(root, "runtime/manage-discord-sessions");
		mkdirSync(join(root, "runtime"), { mode: 0o700 });
		materializeGitRuntime({ adkRoot: paths.root, revision: sourceRevision, expectedTreeId: sourceRuntimeTreeId, runtimePath });
		const runtimeSha256 = hashTree(runtimePath);
		const service = renderDiscordUserUnit({
			adkRoot: paths.root,
			instance: paths.instance,
			tokenFingerprint,
			runtimeRevision: sourceRevision,
			runtimeTreeId: sourceRuntimeTreeId,
			runtimeArtifactSha256: runtimeSha256,
			runtimeArtifactDirectory: root,
			nodePath,
			backendExecutables,
			credentialProfiles,
			homeDirectory,
			servicePath: join(runtimePath, "helper/service.mjs"),
		});
		const supervisor = renderDiscordSupervisorUnits({ adkRoot: paths.root, instance: paths.instance, runtimeRevision: sourceRevision, runtimeTreeId: sourceRuntimeTreeId, runtimeArtifactSha256: runtimeSha256, runtimeArtifactDirectory: root, nodePath, supervisorPath: join(runtimePath, "helper/supervisor-entry.mjs") });
		const content = { service: service.content, supervisorService: supervisor.serviceContent, supervisorTimer: supervisor.timerContent };
		const names = { service: service.unitName, supervisorService: supervisor.serviceName, supervisorTimer: supervisor.timerName };
		const manifest = {
			schemaVersion: 1,
			instance: paths.instance,
			sourceRevision,
			sourceRuntimeTreeId,
			runtimeSha256,
			units: { names, sha256: Object.fromEntries(Object.entries(content).map(([key, value]) => [key, sha256(Buffer.from(value))])) },
		};
		atomicPrivateWrite(join(root, "runtime-artifact.json"), `${JSON.stringify(manifest, null, 2)}\n`, "Discord managed runtime manifest");
		const verified = verifyManagedRuntimeArtifact({ artifactDirectory: root, expectedRuntimePath: runtimePath, expectedRevision: sourceRevision, expectedRuntimeTreeId: sourceRuntimeTreeId, expectedRuntimeSha256: runtimeSha256 });
		return Object.freeze({ ...verified, service: Object.freeze({ unitName: service.unitName, content: service.content }), supervisor: Object.freeze({ serviceName: supervisor.serviceName, timerName: supervisor.timerName, serviceContent: supervisor.serviceContent, timerContent: supervisor.timerContent }) });
	} catch (error) {
		if (ownsArtifactDirectory) rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

export function inspectCutoverCandidateRuntime(candidateRoot) {
	if (typeof candidateRoot !== "string" || !isAbsolute(candidateRoot)) throw new Error("candidateRoot must be absolute");
	const root = realpathSync(candidateRoot);
	const status = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--", RUNTIME_GIT_PATH], { encoding: "utf8", timeout: 10_000 });
	if (status.status !== 0 || status.stdout.trim()) throw new Error("candidate Discord runtime tree must be clean");
	const revision = gitObjectId(gitText(root, ["rev-parse", "HEAD"], "candidate Git revision"), "candidate Git revision");
	return Object.freeze({ root, revision, runtimeTreeId: gitRuntimeTreeId(root, revision) });
}
