import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, openSync, readFileSync, lstatSync, writeSync } from "node:fs";
import { join } from "node:path";
import { approvalRequestedText, assertSupportedBackendVersion, getBackendAdapter, inspectBackendLine, readOnlyBackendOptions } from "./adapters.mjs";
import { cleanupChildEnvironment, prepareChildEnvironment, resolveExecutionCwd } from "./backend-child-environment.mjs";
import { backendCommand, captureChildOwnership, createOwnedProcessTreeSignaler, killAndWaitForChild, probeBackendVersion, spawnOwnedBackend } from "./backend-owned-process.mjs";
import { boundedSafeExcerpt, sanitizeFinalResponse } from "./sanitize.mjs";
import { validateCredentialProfiles } from "./credential-profiles.mjs";

export { cleanupChildEnvironment, prepareChildEnvironment, resolveExecutionCwd } from "./backend-child-environment.mjs";

function safeCommandOptions(backendId, options) {
	if (options.projectInstructions !== undefined && typeof options.projectInstructions !== "boolean") throw new Error("invalid project instructions option");
	if (options.loginMethod !== undefined && options.loginMethod !== "chatgpt") throw new Error("invalid login method");
	const common = ["approvalPolicy", "model", "networkAccess", "credentialProfiles"];
	const allowed = backendId === "codex" ? new Set([...common, "sandbox", "costProfile", "reasoningEffort", "projectInstructions", "loginMethod"]) : backendId === "opencode" ? new Set([...common, "auto"]) : backendId === "grok" ? new Set([...common, "permissionMode", "sandbox", "costProfile", "reasoningEffort"]) : new Set([...common, "permissionMode"]);
	for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`unsupported ${backendId} command option: ${key}`);
	if (backendId === "codex" && options.sandbox && !new Set(["read-only", "workspace-write", "danger-full-access"]).has(options.sandbox)) throw new Error("unsafe Codex sandbox option");
	if (options.model !== undefined && (typeof options.model !== "string" || !/^(?=.{1,80}$)[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/.test(options.model))) throw new Error(`unsafe ${backendId} model option`);
	if (backendId === "codex" && options.costProfile !== undefined && !new Set(["control", "balanced", "economy"]).has(options.costProfile)) throw new Error("unsafe Codex cost profile option");
	if (backendId === "codex" && options.reasoningEffort !== undefined && !new Set(["low", "medium", "high", "max"]).has(options.reasoningEffort)) throw new Error("unsafe Codex reasoning effort option");
	if (options.networkAccess !== undefined && typeof options.networkAccess !== "boolean") throw new Error(`unsafe ${backendId} network option`);
	if (backendId === "codex" && options.networkAccess === true && options.sandbox === "read-only") throw new Error("Codex network access requires writable access");
	try { options.credentialProfiles = validateCredentialProfiles(options.credentialProfiles, `${backendId} credential profiles`); }
	catch { throw new Error(`unsafe ${backendId} credential profiles`); }
	if (options.credentialProfiles.length > 0 && options.networkAccess !== true) throw new Error(`${backendId} credential profiles require network access`);
	if (backendId === "claude" && options.permissionMode && !new Set(["bypassPermissions", "plan"]).has(options.permissionMode)) throw new Error("unsafe Claude permission mode");
	if (backendId === "grok" && options.permissionMode && !new Set(["bypassPermissions", "plan"]).has(options.permissionMode)) throw new Error("unsafe Grok permission mode");
	if (backendId === "grok" && options.sandbox !== undefined && !new Set(["read-only", "workspace"]).has(options.sandbox)) throw new Error("unsafe Grok sandbox option");
	if (backendId === "grok") {
		const permissionMode = options.permissionMode ?? "plan";
		const sandbox = options.sandbox ?? (permissionMode === "plan" ? "read-only" : "workspace");
		if (permissionMode === "plan" && sandbox !== "read-only") throw new Error("Grok plan mode requires read-only sandbox");
		if (permissionMode === "bypassPermissions" && sandbox !== "workspace") throw new Error("Grok writable mode requires workspace sandbox");
		options = { ...options, sandbox };
	}
	if (backendId === "grok" && options.costProfile !== undefined && !new Set(["control", "balanced", "economy"]).has(options.costProfile)) throw new Error("unsafe Grok cost profile option");
	if (backendId === "grok" && options.reasoningEffort !== undefined && !new Set(["low", "medium", "high", "max"]).has(options.reasoningEffort)) throw new Error("unsafe Grok reasoning effort option");
	if (backendId === "opencode" && options.auto !== undefined && typeof options.auto !== "boolean") throw new Error("unsafe OpenCode auto option");
	if (options.approvalPolicy !== undefined && options.approvalPolicy !== "never") throw new Error("child approval policy must be never");
	return { ...options, approvalPolicy: "never" };
}

function writePrompt(child, prompt) {
	child.stdin.end(prompt, "utf8");
}

// Backends that take a single-turn prompt from a file get it staged in their
// own child home, owner-only, and removed with the rest of that directory. The
// workspace is never used for this: a staged prompt there would be visible to
// the model as project content and would survive a crash.
function stagePromptFile(childHome, prompt) {
	const target = join(childHome, "prompt.txt");
	const fd = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
	try {
		const buffer = Buffer.from(prompt, "utf8");
		let offset = 0;
		while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
	} finally { closeSync(fd); }
	return target;
}

export function isBenignBackendStdinError(error) {
	return new Set(["EPIPE", "ERR_STREAM_DESTROYED"]).has(error?.code);
}

function withFailureCode(error, code) {
	if (error && typeof error === "object") error.code = code;
	return error;
}

const MAX_STREAM_LINE_BYTES = 256 * 1024;
const STREAM_DRAIN_TIMEOUT_MS = 500;

function lineReader(stream, onLine, onFailure, onChunk = null, onOversizedLine = onFailure, maxLineBytes = MAX_STREAM_LINE_BYTES) {
	let buffered = "";
	let discardingOversizedLine = false;
	stream.setEncoding("utf8");
	const completed = new Promise((resolve) => {
		stream.once("end", () => {
			if (!discardingOversizedLine) {
				const line = buffered.trim();
				if (line) {
					try {
						if (Buffer.byteLength(line, "utf8") > maxLineBytes) onOversizedLine(new Error("backend stream line exceeded the safe limit"));
						else onLine(line);
					} catch { onFailure(new Error("backend stream normalization failed")); }
				}
			}
			resolve();
		});
		stream.once("close", resolve);
		stream.once("error", () => {
			onFailure(new Error("backend stream failed"));
			resolve();
		});
	});
	stream.on("data", (chunk) => {
		try {
			if (onChunk?.(chunk)) {
				buffered = "";
				stream.destroy();
				return;
			}
		} catch {
			onFailure(new Error("backend stream inspection failed"));
			stream.destroy();
			return;
		}
		let remaining = chunk;
		if (discardingOversizedLine) {
			const newline = remaining.indexOf("\n");
			if (newline < 0) return;
			remaining = remaining.slice(newline + 1);
			discardingOversizedLine = false;
		}
		buffered += remaining;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) {
				if (Buffer.byteLength(buffered, "utf8") > maxLineBytes) {
					buffered = "";
					discardingOversizedLine = true;
					try { onOversizedLine(new Error("backend stream line exceeded the safe limit")); } catch { onFailure(new Error("backend stream normalization failed")); }
				}
				break;
			}
			const line = buffered.slice(0, newline).trimEnd();
			buffered = buffered.slice(newline + 1);
			if (line) {
				try {
					if (Buffer.byteLength(line, "utf8") > maxLineBytes) onOversizedLine(new Error("backend stream line exceeded the safe limit"));
					else onLine(line);
				} catch { onFailure(new Error("backend stream normalization failed")); }
			}
		}
	});
	return completed;
}

export async function runBackendAttempt({
	store,
	jobId,
	backendId,
	prompt,
	cwd,
	runtimeRoot,
	executable,
	authRoot,
	parentEnv = process.env,
	// 실제 이슈 하나를 조사·구현·검증하고 배포 승인까지 받으려면 30분으로는
	// 끝나지 않는다. 30분에 잘리면 그때까지의 결과가 통째로 버려지고 채널에는
	// 아무것도 남지 않았다. 정체 감지는 softSilence 가 따로 하므로 이 값은
	// 상한 역할만 한다.
	timeoutMs = 90 * 60 * 1000,
	killGraceMs = 5_000,
	signal,
	commandOptions = {},
	allowedPaths = null,
	backendVersion,
	versionProbeTimeoutMs = 5_000,
	requireAuthentication = true,
	now = () => new Date().toISOString(),
	onSafeEvent = null,
	preSpawnCheck = null,
	prepareEnvironment = prepareChildEnvironment,
	strictStructuredOutput = false,
	maxStreamLineBytes = MAX_STREAM_LINE_BYTES,
}) {
	if (!Number.isSafeInteger(maxStreamLineBytes) || maxStreamLineBytes < 1024 || maxStreamLineBytes > 16_000_000) throw new Error("invalid stream line limit");
	if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive safe integer");
	if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) throw new Error("killGraceMs must be a non-negative safe integer");
	if (!Number.isSafeInteger(versionProbeTimeoutMs) || versionProbeTimeoutMs < 50 || versionProbeTimeoutMs > 30_000) throw new Error("versionProbeTimeoutMs must be between 50 and 30000");
	const abortedResult = () => {
		const terminationReason = signal.reason === "recovery" ? "recovery" : "cancelled";
		if (terminationReason === "recovery") store.recordEvent({ jobId, source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } });
		else store.recordEvent({ jobId, source: "helper", kind: "cancelled", safePayload: {} });
		return { attemptId: null, exitCode: null, signal: null, terminationReason, backendOutcome: null, backendVersion: backendVersion ?? null, transientResult: null };
	};
	if (signal?.aborted) return abortedResult();
	const executionCwd = resolveExecutionCwd(cwd);
	allowedPaths ??= [executionCwd];
	if (!Array.isArray(allowedPaths) || allowedPaths.length < 1 || allowedPaths.length > 16) throw withFailureCode(new Error("allowedPaths must contain between 1 and 16 directories"), "backend_invocation_invalid");
	let executionAllowedPaths;
	try { executionAllowedPaths = [...new Set(allowedPaths.map(resolveExecutionCwd))]; }
	catch (error) { throw withFailureCode(error, "backend_invocation_invalid"); }
	if (!executionAllowedPaths.includes(executionCwd)) throw withFailureCode(new Error("allowedPaths must include cwd"), "backend_invocation_invalid");
	const adapter = getBackendAdapter(backendId);
	let safeOptions;
	try { safeOptions = safeCommandOptions(backendId, commandOptions); }
	catch (error) { throw withFailureCode(error, "backend_invocation_invalid"); }
	let supportedVersion;
	try {
		supportedVersion = backendVersion
			? assertSupportedBackendVersion(backendId, backendVersion)
			: await probeBackendVersion(backendId, executable, parentEnv, { signal, timeoutMs: versionProbeTimeoutMs });
	} catch (error) {
		if (signal?.aborted) return abortedResult();
		throw withFailureCode(error, "backend_version_probe_failed");
	}
	const attemptId = randomUUID();
	let childEnvironment;
	try {
		childEnvironment = prepareEnvironment({ backendId, attemptId, runtimeRoot, parentEnv, authRoot, workspacePath: executionCwd, prepareAuthentication: requireAuthentication, credentialProfiles: safeOptions.credentialProfiles ?? [], costProfile: safeOptions.costProfile ?? null, readOnly: readOnlyBackendOptions(backendId, safeOptions), model: safeOptions.model ?? null });
	} catch (error) {
		throw withFailureCode(error, "backend_authentication_failed");
	}
	const { childHome, env, authenticationPrepared } = childEnvironment;
	if (requireAuthentication && !authenticationPrepared) {
		cleanupChildEnvironment(childHome);
		throw Object.assign(new Error(`${backendId} authentication is not ready`), { code: "backend_authentication_failed" });
	}
	let child;
	let signalOwnedProcessTree = null;
	try {
		const spec = backendCommand(executable, backendId);
		let invocation;
		const resultPath = backendId === "codex" ? join(childHome, "last-response.txt") : null;
		const promptPath = adapter.promptDelivery === "file" ? stagePromptFile(childHome, prompt) : null;
		try { invocation = adapter.command({ ...safeOptions, resultPath, executable: spec.command, cwd: executionCwd, childHome, allowedPaths: executionAllowedPaths, ...(promptPath ? { promptPath } : {}) }); }
		catch (error) { throw withFailureCode(error, "backend_invocation_invalid"); }
		const windowsScript = process.platform === "win32" && /\.(?:[cm]?js)$/i.test(invocation.command);
		const spawnCommand = windowsScript ? process.execPath : invocation.command;
		const spawnArgs = windowsScript
			? [invocation.command, ...spec.prefixArgs, ...invocation.args]
			: [...spec.prefixArgs, ...invocation.args];
		if (signal?.aborted) {
			cleanupChildEnvironment(childHome);
			return abortedResult();
		}
		if (preSpawnCheck !== null && typeof preSpawnCheck !== "function") throw new Error("preSpawnCheck must be a function");
		preSpawnCheck?.();
		store.reserveAttempt(jobId, { attemptId, backendId, now: now() });
		try { preSpawnCheck?.(); }
		catch (error) {
			const reasonCode = new Set(["context_changed_restart_required", "mutation_window_closed"]).has(error?.code)
				? error.code
				: "internal_error";
			try { store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode }); } catch {}
			throw error;
		}
		child = spawnOwnedBackend(spawnCommand, spawnArgs, {
			cwd: executionCwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		try {
			await new Promise((accept, reject) => {
				child.once(child.ownedProcessHost ? "backendSpawn" : "spawn", accept);
                child.once("backendSpawnError", reject);
                child.once("error", reject);
                child.once("exit", () => reject(new Error("backend host exited before spawn")));
                if (child.backendSpawned) accept();
                if (child.backendSpawnError) reject(child.backendSpawnError);
			});
		} catch (error) {
            await killAndWaitForChild(child, captureChildOwnership(child)?.startIdentity ?? null);
			try {
				store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" });
			} catch {}
			throw withFailureCode(error, "backend_spawn_failed");
		}
		const ownership = captureChildOwnership(child);
		if (!ownership) {
			const terminated = await killAndWaitForChild(child);
			if (terminated) {
				try { store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" }); } catch {}
			}
			throw new Error("child process ownership identity is unavailable");
		}
		const { bootId: ownedBootId, startIdentity: ownedStartIdentity } = ownership;
		try {
			store.attachAttempt(jobId, { attemptId, childPid: child.pid, childBootId: ownedBootId, childStartIdentity: ownedStartIdentity, backendId, now: now() });
		} catch (error) {
			const terminated = await killAndWaitForChild(child, ownedStartIdentity);
			if (terminated) {
				try { store.failAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" }); }
				catch {
					try { store.failReservedAttempt(jobId, { attemptId, now: now(), reasonCode: "internal_error" }); } catch {}
				}
			}
			throw error;
		}
		let lineNumber = 0;
		let backendOutcome = null;
		let backendReceipt = {};
		let failureReasonCode = null;
		let pendingFailureReasonCode = null;
		let transientResult = null;
		let pendingAssistantText = null;
		let progressSequence = 0;
		let processError = false;
		let terminationReason = null;
		let forceTimer = null;
		const signalProcessTree = createOwnedProcessTreeSignaler(child, ownedStartIdentity);
		signalOwnedProcessTree = signalProcessTree;
		const terminate = (reason) => {
			if (terminationReason) return;
			terminationReason = reason;
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "cancel_requested", safePayload: {} });
			signalProcessTree("SIGTERM");
			forceTimer = setTimeout(() => signalProcessTree("SIGKILL"), killGraceMs);
			forceTimer.unref?.();
		};
		const approvalChunkDetector = () => {
			let tail = "";
			return (chunk) => {
				tail = `${tail}${chunk}`.slice(-256);
				if (!approvalRequestedText(tail)) return false;
				terminate("approval_ui");
				return true;
			};
		};
		const recordProgress = (text) => {
			const safe = boundedSafeExcerpt(text);
			if (!safe) return;
			progressSequence += 1;
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:progress:${attemptId}:${progressSequence}`, kind: "progress_reported", safePayload: { excerpt: safe.excerpt }, metrics: { truncated: safe.truncated }, redactionLevel: "local_safe" });
		};
		const recordLine = (line) => {
			lineNumber += 1;
			const inspected = inspectBackendLine({ backendId, line, attemptId, lineNumber });
			if (strictStructuredOutput && inspected.structured === false) { streamFailure(); return; }
			backendReceipt = { ...backendReceipt, ...inspected.receipt };
			failureReasonCode ??= inspected.failureReasonCode;
			pendingFailureReasonCode ??= inspected.pendingFailureReasonCode;
			if (inspected.approvalRequested) {
				terminate("approval_ui");
				return;
			}
			if (inspected.outcome === "failure") backendOutcome = "failure";
			else if (inspected.outcome === "success" && backendOutcome !== "failure") backendOutcome = "success";
			if (inspected.transientResult !== null) transientResult = inspected.transientResult;
			if (inspected.assistantText !== null && inspected.assistantText !== pendingAssistantText) {
				if (pendingAssistantText !== null) recordProgress(pendingAssistantText);
				pendingAssistantText = inspected.assistantText;
			}
			for (const event of inspected.events) {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, ...event });
				try { onSafeEvent?.(event); } catch {}
			}
		};
		let normalizeFailed = false;
		const streamFailure = () => {
			normalizeFailed = true;
			terminate("internal_error");
		};
		// Codex stdout is structured JSON. Do not scan raw tool output or agent text
		// for approval words: ordinary diagnostics can legitimately contain phrases
		// such as "approval request". Explicit structured events are checked by the
		// adapter, while an actual interactive prompt on stderr is still rejected.
		const oversizedStdoutLine = () => {
			lineNumber += 1;
			const bytes = MAX_STREAM_LINE_BYTES + 1;
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:stdout-oversized:${lineNumber}`, kind: "output_activity", safePayload: { bytes }, metrics: { bytes } });
		};
		const stdoutCompleted = lineReader(child.stdout, recordLine, streamFailure, null, strictStructuredOutput ? streamFailure : oversizedStdoutLine, maxStreamLineBytes);
		const stderrCompleted = lineReader(child.stderr, (line) => {
			lineNumber += 1;
			const inspected = inspectBackendLine({ backendId, line, attemptId, lineNumber });
			pendingFailureReasonCode ??= inspected.failureReasonCode ?? inspected.pendingFailureReasonCode;
			if (inspected.approvalRequested) {
				terminate("approval_ui");
				return;
			}
			const bytes = Buffer.byteLength(line, "utf8");
			store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:stderr:${lineNumber}`, kind: "output_activity", safePayload: { bytes }, metrics: { bytes } });
		}, streamFailure, approvalChunkDetector());
		const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
		timeout.unref?.();
		const abort = () => {
			const reason = signal?.reason;
			terminate(reason === "recovery" ? "recovery" : reason === "no_progress" ? "no_progress" : "cancelled");
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		// A backend can close its stdin after consuming the one-shot prompt while it
		// is still flushing the final structured result. Node may surface that normal
		// pipe close as EPIPE/ERR_STREAM_DESTROYED. The exit code and structured
		// completion marker remain authoritative; cancelling here discards a valid
		// final response during an otherwise clean exit.
		child.stdin.on("error", (error) => {
			if (!isBenignBackendStdinError(error)) terminate("internal_error");
		});
		// A file-delivered prompt still needs stdin closed, or the child waits
		// on a stream that will never carry anything.
		if (promptPath) child.stdin.end();
		else writePrompt(child, prompt);
		const result = await new Promise((resolveExit) => {
			let settled = false;
			const finish = (exitCode, exitSignal) => {
				if (settled) return;
				settled = true;
				resolveExit({ exitCode, signal: exitSignal });
			};
			child.once("error", () => {
				processError = true;
				terminate("internal_error");
			});
			child.once("backendExit", finish);
            child.once("backendSpawnError", () => { processError = true; terminate("internal_error"); });
            child.once("exit", (code, signal) => {
                if (child.backendExit) finish(child.backendExit.exitCode, child.backendExit.signal);
                else { if (child.ownedProcessHost) processError = true; finish(code, signal); }
            });
            if (child.backendExit) finish(child.backendExit.exitCode, child.backendExit.signal);
			if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode, child.signalCode);
		});
		// With a persistent leader, terminate owned descendants before draining
        // pipes they may retain after the actual backend has exited.
        const cleanupConfirmed = child.ownedProcessHost ? await killAndWaitForChild(child, ownedStartIdentity) : true;
        if (!cleanupConfirmed) {
            processError = true;
            terminationReason = "internal_error";
            backendOutcome = "failure";
            failureReasonCode = "internal_error";
        }
        const streamsCompleted = Promise.all([stdoutCompleted, stderrCompleted]);
		let drainTimer;
		const streamsDrained = await Promise.race([
			streamsCompleted.then(() => true),
			new Promise((resolveDrain) => {
				drainTimer = setTimeout(() => resolveDrain(false), STREAM_DRAIN_TIMEOUT_MS);
				drainTimer.unref?.();
			}),
		]);
		clearTimeout(drainTimer);
		if (!streamsDrained) {
			terminate("internal_error");
			let forcedDrainTimer;
			const drainedAfterTermination = await Promise.race([
				streamsCompleted.then(() => true),
				new Promise((resolveDrain) => {
					forcedDrainTimer = setTimeout(() => resolveDrain(false), killGraceMs + 250);
					forcedDrainTimer.unref?.();
				}),
			]);
			clearTimeout(forcedDrainTimer);
			if (!drainedAfterTermination) {
				signalProcessTree("SIGKILL");
				child.stdout.destroy();
				child.stderr.destroy();
				await streamsCompleted;
			}
		}
		clearTimeout(timeout);
		if (forceTimer) clearTimeout(forceTimer);
		signal?.removeEventListener("abort", abort);
		let finalResultInvalid = false;
        if (resultPath && result.exitCode === 0 && backendOutcome === "success") {
            if (existsSync(resultPath)) {
                const stat = lstatSync(resultPath);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_000) finalResultInvalid = true;
                else {
                    const text = readFileSync(resultPath, "utf8").trim();
                    if (text) transientResult = text;
                    else if (strictStructuredOutput) finalResultInvalid = true;
                }
            } else if (strictStructuredOutput) finalResultInvalid = true;
            if (finalResultInvalid) { backendOutcome = "failure"; failureReasonCode = "internal_error"; }
        }
		const processFailed = result.signal !== null || (result.exitCode !== null && result.exitCode !== 0);
		if (failureReasonCode === null && processFailed && pendingFailureReasonCode !== null) {
			failureReasonCode = pendingFailureReasonCode;
			backendOutcome = "failure";
		}
		try {
			if (result.signal) {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "attempt_exited", safePayload: { terminationKind: "signaled", signal: result.signal } });
			} else {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "attempt_exited", safePayload: { terminationKind: "exited", exitCode: result.exitCode ?? 1 }, metrics: { exitCode: result.exitCode ?? 1 } });
			}
			if (!(result.exitCode === 0 && backendOutcome === "success") && pendingAssistantText !== null) recordProgress(pendingAssistantText);
			if (terminationReason === "cancelled") {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "cancelled", safePayload: {} });
			} else if (terminationReason === "recovery") {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "recovery", kind: "recovered", safePayload: { recoveryAction: "safe_retry" } });
			} else if (terminationReason === "timeout") {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "timeout" } });
			} else if (terminationReason === "no_progress") {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "no_progress_timeout" } });
			} else if (terminationReason === "approval_ui") {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "approval_ui_detected" } });
			} else if (terminationReason === "internal_error" || normalizeFailed || processError) {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
			} else if (result.exitCode === 0 && backendOutcome === "success") {
				if (pendingAssistantText !== null && pendingAssistantText !== transientResult) recordProgress(pendingAssistantText);
				if (transientResult !== null) {
					try {
						const safeResult = boundedSafeExcerpt(sanitizeFinalResponse(transientResult));
						if (safeResult) store.recordEvent({ jobId, attemptId, occurredAt: now(), source: backendId, dedupeKey: `${backendId}:result:${attemptId}`, kind: "result_reported", safePayload: { excerpt: safeResult.excerpt }, metrics: { truncated: safeResult.truncated }, redactionLevel: "local_safe" });
					} catch {}
				}
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "attempt_succeeded", safePayload: {} });
			} else {
				store.recordEvent({ jobId, attemptId, occurredAt: now(), source: "helper", kind: "failed", safePayload: { reasonCode: failureReasonCode ?? (result.exitCode === 0 ? "internal_error" : "process_exit") } });
			}
			return { attemptId, exitCode: result.exitCode, signal: result.signal, terminationReason, backendOutcome, failureReasonCode, backendVersion: supportedVersion, backendReceipt, finalResultInvalid, cleanupConfirmed, transientResult: backendOutcome === "success" ? transientResult : null };
		} finally {
			if (existsSync(childHome)) cleanupChildEnvironment(childHome);
		}
	} finally {
		if (child) {
			try {
				if (process.platform === "win32") {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}
				else signalOwnedProcessTree?.("SIGKILL");
			} catch (error) {
				if (error?.code !== "ESRCH") throw error;
			}
		}
		if (existsSync(childHome)) cleanupChildEnvironment(childHome);
	}
}
