import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { assertSupportedBackendVersion } from "./adapters.mjs";
import { readBootId, readProcessStartIdentity } from "./projector.mjs";
import { trustedWindowsSystemExecutable } from "./platform-security.mjs";

export function spawnOwnedBackend(command, args, options) {
 if (process.platform !== "linux") return spawn(command, args, options);
 const child = spawn(process.execPath, [fileURLToPath(new URL("./backend-process-host.mjs", import.meta.url))], { ...options, detached: true, stdio: [...options.stdio, "ipc"] });
 child.ownedProcessHost = true;
 child.on("message", message => {
  if (message?.version !== 1) return;
  if (message.operation === "spawned") { child.backendSpawned = true; child.emit("backendSpawn"); }
  else if (message.operation === "spawn_error") {
   const error = Object.assign(new Error(message.code === "ENOENT" ? "backend executable ENOENT" : "backend spawn failed"), { code: message.code === "ENOENT" ? "ENOENT" : "backend_spawn_failed" });
   child.backendSpawnError = error; child.emit("backendSpawnError", error);
  } else if (message.operation === "exited" && (message.exitCode === null || Number.isInteger(message.exitCode)) && (message.signal === null || /^SIG[A-Z0-9]+$/.test(message.signal))) {
   child.backendExit = { exitCode: message.exitCode, signal: message.signal }; child.emit("backendExit", message.exitCode, message.signal);
  }
 });
 child.once("spawn", () => child.send({ version: 1, operation: "spawn", command, args }, error => { if (error) child.emit("backendSpawnError", error); }));
 return child;
}

function processIsAlive(pid) {
	try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function processGroupIsAlive(pid) {
	try { process.kill(-pid, 0); } catch (error) { return error?.code === "EPERM"; }
    if (process.platform !== "linux") return true;
    // Zombies cannot execute and may remain until their new parent reaps them.
    // Unreadable process state stays unknown/alive, never confirmed cleaned.
    try {
        for (const name of readdirSync("/proc")) {
            if (!/^[0-9]+$/.test(name)) continue;
            let stat;
            try { stat = readFileSync(`/proc/${name}/stat`, "utf8"); }
            catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; return true; }
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
            if (Number(fields[2]) === pid && !["Z", "X"].includes(fields[0])) return true;
        }
        return false;
    } catch { return true; }
}

function waitForChildExit(child, timeoutMs = 2_000, group = false) {
	const alive = () => group ? processGroupIsAlive(child.pid) : processIsAlive(child.pid);
	if (!group && (child.exitCode !== null || child.signalCode !== null || alive() === false)) return Promise.resolve(true);
	if (group && alive() === false) return Promise.resolve(true);
	return new Promise((resolveExit) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(poll);
			resolveExit(exited);
		};
		const check = () => { if (alive() === false) finish(true); };
		child.once("exit", group ? check : () => finish(true));
		child.once("close", group ? check : () => finish(true));
		const poll = group ? setInterval(check, 10) : null;
		const timer = setTimeout(() => finish(alive() === false), timeoutMs);
	});
}

export async function killAndWaitForChild(child, ownedStartIdentity = null) {
	try {
		if (process.platform === "win32") {
			if (processIsAlive(child.pid) === false) return true;
			const killed = spawnSync(trustedWindowsSystemExecutable("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
			if (killed.status !== 0 && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		} else {
			if (ownedStartIdentity === null) {
                if (child.ownedProcessHost) {
                    // The private IPC channel remains an ownership capability:
                    // its EOF asks a live guardian to clean its own group.
                    if (child.connected) child.disconnect();
                    return waitForChildExit(child, 2_000, true);
                }
				if (child.exitCode !== null || child.signalCode !== null) return waitForChildExit(child, 2_000, true);
				child.kill("SIGKILL");
				return waitForChildExit(child, 2_000, false);
			}
			const currentIdentity = readProcessStartIdentity(child.pid);
			if (currentIdentity !== ownedStartIdentity) {
				if (currentIdentity === null && child.exitCode === null && child.signalCode === null) {
                    if (child.ownedProcessHost) return waitForChildExit(child, 2_000, true);
					child.kill("SIGKILL");
					return waitForChildExit(child, 2_000, false);
				}
				return waitForChildExit(child, 2_000, true);
			}
			process.kill(-child.pid, "SIGKILL");
		}
	} catch {}
	return waitForChildExit(child, 2_000, process.platform !== "win32");
}

export function backendCommand(executable, fallback) {
	if (executable === undefined || executable === null) return { command: fallback, prefixArgs: [] };
	if (typeof executable === "string" && executable.length > 0) return { command: executable, prefixArgs: [] };
	if (typeof executable === "object" && typeof executable.command === "string" && executable.command.length > 0
		&& Array.isArray(executable.prefixArgs) && executable.prefixArgs.every((item) => typeof item === "string" && item.length > 0)) {
		return { command: executable.command, prefixArgs: [...executable.prefixArgs] };
	}
	throw new Error("backend executable contract is invalid");
}

export async function probeBackendVersion(backendId, executable, parentEnv, { signal, timeoutMs = 5_000 } = {}) {
	const spec = backendCommand(executable, backendId);
	const windowsScript = process.platform === "win32" && /\.(?:[cm]?js)$/i.test(spec.command);
	const probeCommand = windowsScript ? process.execPath : spec.command;
	const probeArgs = windowsScript ? [spec.command, ...spec.prefixArgs, "--version"] : [...spec.prefixArgs, "--version"];
	const child = spawnOwnedBackend(probeCommand, probeArgs, { env: { PATH: parentEnv.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
	const ownedStartIdentity = process.platform === "win32" ? null : readProcessStartIdentity(child.pid);
	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => { if (output.length < 4_096) output += chunk.slice(0, 4_096 - output.length); });
	}
	let cancel;
	const cancellation = new Promise((resolveCancellation) => { cancel = resolveCancellation; });
	let cancelling = false;
	let cancellationReason = null;
	const stop = (reason) => {
		if (cancelling) return;
		cancelling = true;
		cancellationReason = reason;
		void (async () => {
			await killAndWaitForChild(child, ownedStartIdentity);
			cancel({ reason });
		})();
	};
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	timer.unref?.();
	const abort = () => stop("aborted");
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	let result;
	try {
		result = await Promise.race([
			new Promise((resolveExit, rejectExit) => {
                child.once("error", rejectExit);
                child.once("backendSpawnError", rejectExit);
                child.once("backendExit", exitCode => resolveExit({ exitCode, reason: cancellationReason }));
                child.once("close", (exitCode) => resolveExit({ exitCode: child.ownedProcessHost && !child.backendExit ? 1 : exitCode, reason: cancellationReason }));
                if (child.backendExit) resolveExit({ exitCode: child.backendExit.exitCode, reason: cancellationReason });
			}),
			cancellation,
		]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (child.ownedProcessHost && !await killAndWaitForChild(child, ownedStartIdentity)) {
            throw new Error(`${backendId} version probe cleanup unconfirmed`);
        }
    }
	if (result.reason === "timeout") throw new Error(`${backendId} version probe timed out`);
	if (result.reason === "aborted") throw new Error(`${backendId} version probe aborted`);
	if (result.exitCode !== 0) throw new Error(`${backendId} version probe failed`);
	return assertSupportedBackendVersion(backendId, output);
}

export function captureChildOwnership(child) {
	const bootId = readBootId();
	const startIdentity = readProcessStartIdentity(child.pid);
	return bootId && startIdentity ? { bootId, startIdentity } : null;
}

export function createOwnedProcessTreeSignaler(child, ownedStartIdentity) {
	return (signalName) => {
		try {
			if (process.platform === "win32") {
				if (child.exitCode === null && child.signalCode === null) {
					const taskkill = trustedWindowsSystemExecutable("taskkill.exe");
					const args = ["/PID", String(child.pid), "/T"];
					if (signalName === "SIGKILL") args.push("/F");
					const killed = spawnSync(taskkill, args, { encoding: "utf8", windowsHide: true });
					if (killed.status !== 0 && child.exitCode === null && child.signalCode === null) child.kill(signalName);
				}
			} else {
				const currentIdentity = readProcessStartIdentity(child.pid);
				if (currentIdentity !== ownedStartIdentity) return;
				process.kill(-child.pid, signalName);
			}
		} catch (error) {
			if (error?.code !== "ESRCH") throw error;
		}
	};
}
