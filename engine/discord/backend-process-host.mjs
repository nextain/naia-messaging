// A private process-group leader that outlives the backend. The runner can
// therefore verify a current leader identity even after the backend exits.
import { spawn } from 'node:child_process';
import { closeSync, readFileSync } from 'node:fs';

if (process.platform !== 'linux' || !process.connected || typeof process.send !== 'function') process.exit(78);
const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[2]) !== process.pid) process.exit(78);
let initialized = false;
let backend = null;
const keepAlive = setInterval(() => {}, 1000);
const emit = value => { if (process.connected) process.send({ version: 1, ...value }, () => {}); };
const cleanup = () => {
  // This process itself is the still-living group leader; no stale PID lookup.
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
};
process.on('disconnect', cleanup);
// The runner signals the entire group. Keep the leader alive until SIGKILL so
// a child that ignores SIGTERM cannot outlive the exact-identity cleanup.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('message', message => {
  if (initialized || message?.version !== 1 || message.operation !== 'spawn'
      || typeof message.command !== 'string' || !message.command
      || !Array.isArray(message.args) || message.args.some(value => typeof value !== 'string')) { cleanup(); return; }
  initialized = true;
  // Descriptor 3 (private IPC) is never inherited by the model process.
  backend = spawn(message.command, message.args, { cwd: process.cwd(), env: process.env, stdio: [0, 1, 2], detached: false });
  backend.once('spawn', () => emit({ operation: 'spawned' }));
  backend.once('error', error => {
    emit({ operation: 'spawn_error', code: error.code === 'ENOENT' ? 'ENOENT' : 'backend_spawn_failed' });
  });
  backend.once('exit', (exitCode, signal) => {
    // The backend may have descendants holding these pipes. The runner kills
    // the owned group on this receipt, then drains all already-written output.
    for (const fd of [0, 1, 2]) { try { closeSync(fd); } catch {} }
    emit({ operation: 'exited', exitCode, signal });
  });
});
// A parent which never sends initialization must not leave an idle leader.
setTimeout(() => { if (!initialized) cleanup(); }, 10000).unref();
