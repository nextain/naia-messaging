import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discordUnitIdentity } from "./systemd.mjs";
import { messengerInstancePaths } from "./instance-paths.mjs";
import { assertOwnerOnly } from "./platform-security.mjs";
import { acquireDiscordArtifactOperationLock } from "./cutover-artifact-lock.mjs";
import { activeCutoverRollbackBundle, verifyCutoverRollbackBundle } from "./cutover-rollback.mjs";
import { systemctlState, verifyLinuxManagedRegistration, verifyManagedRuntimeArtifact } from "./cutover-managed-runtime.mjs";

function artifactDirectories(root, kind) {
	if (!existsSync(root)) return [];
	assertOwnerOnly(root, "directory", `Discord ${kind} root`);
	return readdirSync(root, { withFileTypes: true }).map((entry) => {
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Discord ${kind} root contains an unsafe entry`);
		const path = resolve(root, entry.name);
		if (dirname(path) !== resolve(root)) throw new Error(`Discord ${kind} path escaped its root`);
		assertOwnerOnly(path, "directory", `Discord ${kind}`);
		return { id: entry.name, path };
	});
}

export function listManagedDiscordArtifacts({ adkRoot, instance = "default", unitDirectory = resolve(homedir(), ".config/systemd/user"), stateReader = systemctlState } = {}) {
	const paths = messengerInstancePaths(realpathSync(resolve(adkRoot)), instance);
	const identity = discordUnitIdentity(paths.root, paths.instance);
	const base = identity.unitName.slice(0, -".service".length);
	const registrationPaths = {
		service: resolve(unitDirectory, identity.unitName),
		supervisorService: resolve(unitDirectory, `${base}-supervisor.service`),
		supervisorTimer: resolve(unitDirectory, `${base}-supervisor.timer`),
	};
	let installedArtifactPath = null;
	let registration = "legacy_or_invalid";
	try {
		const installed = verifyLinuxManagedRegistration({ adkRoot: paths.root, instance: paths.instance, unitDirectory, stateReader });
		installedArtifactPath = installed.artifact.artifactDirectory;
		registration = "managed_artifact";
	} catch (error) {
		if (!Object.values(registrationPaths).some((path) => existsSync(path))) registration = "absent";
		else if (!existsSync(registrationPaths.service) || readFileSync(registrationPaths.service, "utf8").includes("NAIA_DISCORD_RUNTIME_ARTIFACT=")) throw error;
	}
	let activeBundlePath = null;
	if (existsSync(paths.activeRollbackPath)) activeBundlePath = activeCutoverRollbackBundle({ adkRoot: paths.root, instance: paths.instance }).bundleDirectory;
	const items = [];
	for (const item of artifactDirectories(join(paths.stateDirectory, "managed-runtimes"), "managed runtime")) {
		let verified = false;
		try { verifyManagedRuntimeArtifact({ artifactDirectory: item.path }); verified = true; } catch {}
		items.push(Object.freeze({ kind: "managed_runtime", id: item.id, path: item.path, state: !verified ? "invalid_retained" : item.path === installedArtifactPath ? "installed_retained" : "orphaned_verified" }));
	}
	for (const item of artifactDirectories(join(paths.stateDirectory, "rollback-bundles"), "rollback bundle")) {
		let verified = false;
		try { verifyCutoverRollbackBundle(item.path); verified = true; } catch {}
		const retained = item.path === activeBundlePath || item.path === installedArtifactPath;
		items.push(Object.freeze({ kind: "rollback_bundle", id: item.id, path: item.path, state: !verified ? "invalid_retained" : retained ? "active_retained" : "orphaned_verified" }));
	}
	return Object.freeze({ schemaVersion: 1, instance: paths.instance, registration, items: Object.freeze(items.sort((left, right) => left.path.localeCompare(right.path))) });
}

export function pruneManagedDiscordArtifacts(options = {}, acquireOperation = acquireDiscordArtifactOperationLock) {
	const operation = acquireOperation(options);
	try {
		const inventory = listManagedDiscordArtifacts(options);
		if (!new Set(["managed_artifact", "absent"]).has(inventory.registration)) throw new Error("Discord artifact pruning requires an absent or verified managed registration");
		const removed = [];
		for (const item of inventory.items.filter((entry) => entry.state === "orphaned_verified")) {
			if (item.kind === "managed_runtime") verifyManagedRuntimeArtifact({ artifactDirectory: item.path });
			else verifyCutoverRollbackBundle(item.path);
			const quarantinePath = `${item.path}.prune-${randomUUID()}`;
			renameSync(item.path, quarantinePath);
			rmSync(quarantinePath, { recursive: true, force: false });
			removed.push(Object.freeze({ kind: item.kind, id: item.id }));
		}
		return Object.freeze({ schemaVersion: 1, instance: inventory.instance, removed: Object.freeze(removed) });
	} finally { operation.release(); }
}
