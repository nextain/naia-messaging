// Trusted host adapter for an already-claimed task. This ledger records execution
// evidence only; the host retains queue, approval, routing and delivery ownership.
import { mkdirSync, chmodSync, existsSync, lstatSync } from 'node:fs';
import { join, isAbsolute, resolve, parse } from 'node:path';
import { SessionStore } from '../engine/discord/store.mjs';
import { runBackendAttempt } from '../engine/discord/backend-runner.mjs';
import { safeIdentifier } from '../core/redact.mjs';

function hostEnvironment({ runtimeRoot, attemptId, parentEnv }) {
  const childHome = join(runtimeRoot, 'children', attemptId);
  mkdirSync(childHome, { recursive: true, mode: 0o700 }); chmodSync(childHome, 0o700);
  // Existing host credentials stay in their normal stores. Never inherit the
  // messenger token, service config references, API overrides or hook/session env.
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'XDG_RUNTIME_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (parentEnv[key]) env[key] = parentEnv[key];
  }
  env.NO_COLOR = '1';
  return { childHome, env, authenticationPrepared: true };
}

export async function runClaimedBackendTask(input, { signal, parentEnv = process.env, requireAuthentication = true } = {}) {
  const { jobId, cwd, prompt, stateRoot, executable, model, reasoningEffort, timeoutMs } = input;
  safeIdentifier(jobId, 'jobId');
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) throw new Error('invalid task state root');
  if (typeof executable !== 'string' || !isAbsolute(executable)) throw new Error('invalid backend executable');
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > 1_000_000 || !prompt.trim()) throw new Error('invalid task prompt');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) throw new Error('invalid task timeout');
  const authenticationRoot = parentEnv.HOME ?? parentEnv.USERPROFILE;
  if (typeof authenticationRoot !== 'string' || !isAbsolute(authenticationRoot)) throw new Error('host authentication root missing');
  let cursor = stateRoot;
  const filesystemRoot = parse(stateRoot).root;
  while (cursor !== filesystemRoot) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('task state root contains a symbolic link');
    cursor = resolve(cursor, '..');
  }
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 }); chmodSync(stateRoot, 0o700);
  const store = new SessionStore(join(stateRoot, 'executions.sqlite3'));
  let attempt = null;
  try {
    // An existing task is never executed again after a bridge/host crash.
    if (store.getJob(jobId)) return { status: 'error', kind: 'execution_already_recorded', execution_started: true };
    store.createJob({ jobId, backendId: 'codex', revision: 'host-v1', activityDetail: 'structured', jobType: 'issue_work' });
    attempt = await runBackendAttempt({ store, jobId, backendId: 'codex', prompt, cwd, runtimeRoot: stateRoot, executable,
      parentEnv, requireAuthentication, strictStructuredOutput: true, maxStreamLineBytes: 16_000_000, prepareEnvironment: hostEnvironment, signal, timeoutMs, killGraceMs: 1000,
      commandOptions: { model, reasoningEffort, sandbox: 'workspace-write', approvalPolicy: 'never', networkAccess: true, projectInstructions: true, loginMethod: 'chatgpt' },
    });
    const ok = attempt.cleanupConfirmed !== false && attempt.exitCode === 0 && attempt.backendOutcome === 'success' && !attempt.terminationReason && typeof attempt.transientResult === 'string' && attempt.transientResult.trim() && Buffer.byteLength(attempt.transientResult) <= 16_000;
    const job = store.getJob(jobId);
    return { status: ok ? 'ok' : 'error', kind: ok ? null : attempt.cleanupConfirmed === false ? 'owned_cleanup_unconfirmed' : attempt.finalResultInvalid ? 'invalid_final_reply' : attempt.terminationReason ?? attempt.failureReasonCode ?? 'backend_failed',
      execution_started: Boolean(attempt.attemptId), attemptId: attempt.attemptId, exit_code: attempt.exitCode,
      ...(ok ? { resultText: attempt.transientResult } : {}), lifecycle: job.lifecycle,
      thread_id: attempt.backendReceipt?.threadId ?? null, usage: attempt.backendReceipt?.usage ?? {},
    };
  } catch (error) {
    const job = store.getJob(jobId);
    return { status: 'error', kind: error?.code ?? 'backend_execution_failed', execution_started: Boolean(job?.attemptId || job?.events?.some(event => ['attempt_started', 'attempt_start_reserved', 'attempt_exited'].includes(event.kind))) };
  } finally { store.close(); }
}
