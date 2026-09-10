import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	rmdirSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";
import { readBootId, readProcessStartIdentity } from "./projector.mjs";

const OWNER_FILE = "owner.json";

export class DiscordTokenAlreadyOwnedError extends Error {
	constructor() {
		super("Discord token is already owned by another process");
		this.name = "DiscordTokenAlreadyOwnedError";
		this.code = "DISCORD_TOKEN_ALREADY_OWNED";
	}
}

function unavailable() {
	const error = new Error("Discord token ownership lock is unavailable");
	error.code = "DISCORD_TOKEN_LOCK_UNAVAILABLE";
	return error;
}

export function discordTokenFingerprint(token) {
	if (typeof token !== "string" || token.length < 16) throw unavailable();
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function readOwner(lockPath) {
	const ownerPath = resolve(lockPath, OWNER_FILE);
	const stat = lstatSync(ownerPath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
	assertOwnerOnly(ownerPath, "file", "Discord token ownership record");
	const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
	if (owner?.schemaVersion !== 2 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(owner.nonce) || typeof owner.host !== "string" || typeof owner.bootId !== "string" || !owner.bootId || typeof owner.processStartIdentity !== "string" || !owner.processStartIdentity) throw unavailable();
	return owner;
}
function inspectExistingLock(lockPath) {
	const lockStat = lstatSync(lockPath);
	if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw unavailable();
	assertOwnerOnly(lockPath, "directory", "Discord token ownership lock");
	let owner;
	try {
		owner = readOwner(lockPath);
	} catch (error) {
		// A directory without a complete owner record may still belong to a slow
		// initializer. Never reclaim it by age: fail closed and require an explicit
		// operator cleanup rather than risk two live Gateway owners.
		if (error?.code === "ENOENT") return { state: "owned" };
		throw unavailable();
	}
	if (owner.host === hostname() && owner.bootId === readBootId()) {
		try { process.kill(owner.pid, 0); }
		catch (error) {
			if (error?.code === "ESRCH") return { state: "stale", owner };
			if (error?.code !== "EPERM") throw unavailable();
		}
	}
	// Incomplete records, different boots/hosts, EPERM, and PID reuse remain
	// fail-closed. Only an objectively missing PID on this boot is reclaimable.
	return { state: "owned" };
}

function createOwnedLock(lockPath) {
	let directoryCreated = false;
	let fd;
	try {
		mkdirSync(lockPath, { mode: 0o700 });
		directoryCreated = true;
		protectOwnerOnly(lockPath, "directory", "Discord token ownership lock");
		const nonce = randomUUID();
		const bootId = readBootId();
		const processStartIdentity = readProcessStartIdentity(process.pid);
		if (!bootId || !processStartIdentity) throw unavailable();
		const ownerPath = resolve(lockPath, OWNER_FILE);
		const ownerTempPath = resolve(lockPath, `.owner-${nonce}.tmp`);
		fd = openSync(ownerTempPath, "wx", 0o600);
		writeFileSync(fd, JSON.stringify({ schemaVersion: 2, pid: process.pid, host: hostname(), bootId, processStartIdentity, nonce }), "utf8");
		closeSync(fd);
		fd = undefined;
		protectOwnerOnly(ownerTempPath, "file", "Discord token ownership record");
		renameSync(ownerTempPath, ownerPath);
		return nonce;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		if (directoryCreated) rmSync(lockPath, { recursive: true, force: true });
		if (error?.code === "EEXIST") throw error;
		throw unavailable();
	}
}

function acquireStaleReclaimGuard(lockPath) {
	const guardPath = `${lockPath}.reclaim`;
	try {
		mkdirSync(guardPath, { mode: 0o700 });
		protectOwnerOnly(guardPath, "directory", "Discord token stale reclaim guard");
	} catch (error) {
		if (error?.code === "EEXIST") throw new DiscordTokenAlreadyOwnedError();
		throw unavailable();
	}
	let released = false;
	return () => {
		if (released) return;
		try { rmdirSync(guardPath); }
		catch { throw unavailable(); }
		released = true;
	};
}

export function defaultDiscordTokenLockDirectory(environment = process.env, runtime = {}) {
	const configured = environment.NAIA_DISCORD_TOKEN_LOCK_DIRECTORY;
	if (configured !== undefined) {
		if (typeof configured !== "string" || !isAbsolute(configured) || configured.includes("\0")) throw unavailable();
		return resolve(configured);
	}
	const sharedRuntime = environment.XDG_RUNTIME_DIR;
	if (typeof sharedRuntime === "string" && sharedRuntime.startsWith("/") && !sharedRuntime.includes("\0")) {
		return join(resolve(sharedRuntime), "naia-adk", "messenger-token-locks");
	}
	const platform = runtime.platform ?? process.platform;
	const base = platform === "win32" ? tmpdir() : "/tmp";
	const runtimeRoot = resolve(base, `naia-adk-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
	if (platform !== "win32") {
		const bootId = runtime.bootId ?? readBootId();
		if (typeof bootId !== "string" || bootId.length < 1 || bootId.includes("\0")) throw unavailable();
		const bootScope = createHash("sha256").update(bootId, "utf8").digest("hex").slice(0, 16);
		return join(runtimeRoot, "boots", bootScope, "messenger-token-locks");
	}
	return join(runtimeRoot, "messenger-token-locks");
}

export function acquireDiscordTokenOwnerLock({ token, lockDirectory }) {
	const root = resolve(lockDirectory);
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		protectOwnerOnly(root, "directory", "Discord token lock directory");
	} catch {
		throw unavailable();
	}
	const fingerprint = discordTokenFingerprint(token);
	const lockPath = resolve(root, `${fingerprint}.lock`);
	let nonce;
	try {
		nonce = createOwnedLock(lockPath);
	} catch (error) {
		if (error?.code !== "EEXIST") throw unavailable();
		const releaseReclaimGuard = acquireStaleReclaimGuard(lockPath);
		try {
			let existing;
			try { existing = inspectExistingLock(lockPath); }
			catch (inspectionError) {
				if (inspectionError?.code === "ENOENT") throw unavailable();
				throw inspectionError;
			}
			if (existing.state !== "stale") throw new DiscordTokenAlreadyOwnedError();
			const stalePath = `${lockPath}.stale-${randomUUID()}`;
			try { renameSync(lockPath, stalePath); }
			catch (renameError) {
				if (renameError?.code === "ENOENT") throw new DiscordTokenAlreadyOwnedError();
				throw unavailable();
			}
			try {
				nonce = createOwnedLock(lockPath);
				rmSync(stalePath, { recursive: true });
			} catch (reclaimError) {
				if (reclaimError?.code === "EEXIST") {
					rmSync(stalePath, { recursive: true, force: true });
					throw new DiscordTokenAlreadyOwnedError();
				}
				try { renameSync(stalePath, lockPath); } catch {}
				throw unavailable();
			}
		} finally {
			releaseReclaimGuard();
		}
	}

	let released = false;
	return Object.freeze({
		release() {
			if (released) return;
			let owner;
			try {
				owner = readOwner(lockPath);
			} catch {
				throw unavailable();
			}
			if (owner.pid !== process.pid || owner.host !== hostname() || owner.nonce !== nonce) throw unavailable();
			const releasePath = `${lockPath}.release-${nonce}`;
			try {
				renameSync(lockPath, releasePath);
				rmSync(releasePath, { recursive: true });
				released = true;
			} catch {
				throw unavailable();
			}
		},
	});
}
