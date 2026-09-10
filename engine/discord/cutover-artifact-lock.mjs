import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { messengerInstancePaths } from "./instance-paths.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";
import { readProcessStartIdentity } from "./projector.mjs";

function processIsRunning(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0] !== "Z";
	} catch { return false; }
}

function waitForFileOrExit(path, child, timeoutMs = 3_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		if (!processIsRunning(child.pid)) return false;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
	return existsSync(path);
}

export function acquireDiscordArtifactOperationLock({ adkRoot, instance = "default" } = {}) {
	if (process.platform === "win32") throw new Error("Discord artifact operations require Linux kernel flock");
	const paths = messengerInstancePaths(realpathSync(resolve(adkRoot)), instance);
	mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
	protectOwnerOnly(paths.stateDirectory, "directory", "Discord service state");
	const lockPath = resolve(paths.stateDirectory, "artifact-operation.lock");
	writeFileSync(lockPath, "", { flag: "a", mode: 0o600 });
	assertOwnerOnly(lockPath, "file", "Discord artifact operation lock");
	const flockPath = realpathSync("/usr/bin/flock");
	if (!statSync(flockPath).isFile()) throw new Error("Linux kernel flock is unavailable");
	const holderPath = realpathSync(fileURLToPath(new URL("./artifact-operation-lock-holder.mjs", import.meta.url)));
	const nonce = randomUUID();
	const readyPath = resolve(paths.stateDirectory, `.artifact-operation-ready-${nonce}`);
	const child = spawn(flockPath, ["--no-fork", "--exclusive", "--nonblock", lockPath, realpathSync(process.execPath), holderPath, readyPath, nonce], { stdio: ["pipe", "ignore", "ignore"] });
	if (!waitForFileOrExit(readyPath, child) || readFileSync(readyPath, "utf8") !== nonce) {
		try { child.kill("SIGKILL"); } catch {}
		if (existsSync(readyPath)) unlinkSync(readyPath);
		throw new Error("Discord artifact operation is already active");
	}
	assertOwnerOnly(readyPath, "file", "Discord artifact operation readiness");
	const holderIdentity = readProcessStartIdentity(child.pid);
	if (!holderIdentity) {
		try { child.kill("SIGKILL"); } catch {}
		unlinkSync(readyPath);
		throw new Error("Discord artifact operation lock ownership is unavailable");
	}
	let released = false;
	return Object.freeze({
		release() {
			if (released) return;
			if (readFileSync(readyPath, "utf8") !== nonce || !processIsRunning(child.pid) || readProcessStartIdentity(child.pid) !== holderIdentity) throw new Error("Discord artifact operation lock ownership changed");
			child.kill("SIGTERM");
			const deadline = Date.now() + 1_000;
			while (processIsRunning(child.pid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			if (processIsRunning(child.pid)) {
				if (readProcessStartIdentity(child.pid) === holderIdentity) child.kill("SIGKILL");
				throw new Error("Discord artifact operation lock did not release");
			}
			if (existsSync(readyPath)) {
				if (readFileSync(readyPath, "utf8") !== nonce) throw new Error("Discord artifact operation readiness changed");
				unlinkSync(readyPath);
			}
			released = true;
		},
	});
}
