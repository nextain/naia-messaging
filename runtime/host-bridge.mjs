// Owner-process JSONL bridge. Incoming platform/model text is data, never an RPC.
import readline from 'node:readline';
import { runClaimedBackendTask } from './backend-task.mjs';
import { DiscordGatewaySession } from '../engine/discord/discord-gateway.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { classifyDiscordScope } from '../adapters/discord/scope.mjs';
import { postDiscordMessageOnce } from '../adapters/discord/delivery.mjs';

const mode = process.argv[2];
if (!['gateway', 'call', 'backend'].includes(mode)) throw new Error('unsupported bridge mode');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const emit = value => process.stdout.write(`${JSON.stringify({ version: 1, ...value })}\n`);
let initialized = false, session = null, nextId = 0, shuttingDown = false;
let draining = false, drained = false, drainTimer = null;
const pending = new Map();
const idleWaiters = new Set();
const abortController = new AbortController();
let callFinished = false;
function stop() {
  if (shuttingDown) return;
  shuttingDown = true; process.exitCode = 1;
  clearTimeout(drainTimer);
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('host_disconnected')); }
  pending.clear(); session?.close(); abortController.abort();
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
  setTimeout(() => process.exit(1), mode === 'backend' ? 10000 : 1200).unref();
}
const request = (operation, input) => new Promise((resolve, reject) => {
  if (shuttingDown || pending.size >= 64) { reject(new Error('host_bridge_unavailable')); return; }
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('host_callback_timeout')); stop(); }, operation === 'dispatch' ? 90000 : 10000);
  pending.set(id, { resolve, reject, timer }); emit({ id, operation, input });
});
async function drainGateway() {
  if (mode !== 'gateway' || !session || draining || shuttingDown) throw new Error('invalid_gateway_stop');
  draining = true;
  // The owner keeps the ACK pipe open until the admitted dispatch and its final
  // sequence checkpoint have settled. EOF/signals still mean owner failure.
  drainTimer = setTimeout(stop, 12000);
  session.close();
  await session.drain();
  if (pending.size) await new Promise(resolve => idleWaiters.add(resolve));
  if (shuttingDown) return;
  clearTimeout(drainTimer);
  drained = true;
  emit({ operation: 'stopped' });
  lines.close();
}
async function initialize(message) {
  if (message.version !== 1) throw new Error('unsupported_bridge_version');
  if (mode === 'call' || mode === 'backend') {
    const input = message.input ?? {};
    let result;
    if (mode === 'backend') {
      if (message.operation !== 'backend') throw new Error('unsupported_bridge_operation');
      result = await runClaimedBackendTask(input, { signal: abortController.signal });
    }
    else if (message.operation === 'redact') result = redactSecrets(input.text);
    else if (message.operation === 'scope') result = classifyDiscordScope(input.message, new Map(input.threadParents ?? []));
    else if (message.operation === 'delivery') result = await postDiscordMessageOnce(input);
    else throw new Error('unsupported_bridge_operation');
    callFinished = true; emit({ result }); lines.close(); return;
  }
  if (message.operation !== 'gateway') throw new Error('unsupported_bridge_operation');
  const config = message.input;
  let state = { ...config.state };
  const repository = {
    load: () => ({ ...state }),
    async save(patch) { await request('state', patch); state = { ...state, ...patch }; },
    async clearResume() {
      const patch = { sessionId: null, sequence: null, resumeUrl: null };
      await request('state', patch); state = { ...state, ...patch };
    },
  };
  session = new DiscordGatewaySession({ token: config.token, expectedBotUserId: config.botUserId,
    messageContentIntent: config.messageContentIntent === true, stateRepository: repository,
    onDispatch: (type, data, sequence) => request('dispatch', { type, data, sequence }),
    onDisconnect: result => {
      if (draining && result.code === 1000) return;
      emit({ operation: 'disconnected', result }); stop();
    },
  });
  session.connect();
}
lines.on('line', line => {
  try {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('bridge_frame_too_large');
    const message = JSON.parse(line);
    if (!initialized) {
      initialized = true;
      void initialize(message).catch(() => { emit({ error: 'bridge_initialization_failed' }); stop(); });
      return;
    }
    if (message.version === 1 && message.operation === 'stop' && Object.keys(message).every(key => ['version', 'operation'].includes(key))) {
      void drainGateway().catch(() => { emit({ error: 'bridge_drain_failed' }); stop(); });
      return;
    }
    if (message.version !== 1 || !Number.isSafeInteger(message.id) || !pending.has(message.id) || typeof message.ok !== 'boolean') throw new Error('invalid_host_acknowledgement');
    const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok) item.resolve(); else { item.reject(new Error('host_callback_failed')); stop(); }
    if (!pending.size) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  } catch { emit({ error: 'bridge_protocol_failed' }); stop(); }
});
lines.on('close', () => { if (mode === 'gateway' && !drained || mode === 'backend' && !callFinished) stop(); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', stop);
