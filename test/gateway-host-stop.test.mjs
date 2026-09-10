import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-stop-'));
  const preload = join(root, 'socket.mjs');
  writeFileSync(preload, `globalThis.WebSocket = class {
    listeners = new Map();
    constructor() { setImmediate(() => {
      for (const s of [7, 8]) this.listeners.get('message')({data: JSON.stringify({op:0,t:'MESSAGE_CREATE',s,d:{content:'fixture'}})});
    }); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    close(code) { this.listeners.get('close')({code}); }
    send() {}
  };`);
  const child = spawn(process.execPath, ['--import', preload, resolve(import.meta.dirname, '../runtime/host-bridge.mjs'), 'gateway'], {stdio: ['pipe', 'pipe', 'pipe']});
  const closed = once(child, 'close');
  const frames = [];
  const reader = createInterface({input: child.stdout});
  reader.on('line', line => frames.push(JSON.parse(line)));
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const send = value => child.stdin.write(JSON.stringify({version: 1, ...value}) + '\n');
  send({operation: 'gateway', input: {token: 'fixture-credential-value', state: {sequence: 6}}});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    reader.close(); rmSync(root, {recursive: true, force: true});
  });
  return {child, closed, frames, send};
}
async function next(frames, index) {
  for (let i = 0; i < 200; i++) {
    if (frames[index]) return frames[index];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('bridge frame not received');
}

test('owner stop checkpoints the admitted dispatch before its terminal receipt', {timeout: 5000}, async t => {
  const {closed, frames, send} = fixture(t);
  const dispatch = await next(frames, 0);
  assert.equal(dispatch.operation, 'dispatch');
  assert.equal(dispatch.input.sequence, 7);
  send({operation: 'stop'});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(frames.length, 1);
  send({id: dispatch.id, ok: true});
  const state = await next(frames, 1);
  assert.deepEqual(state.input, {sequence: 7});
  assert.equal(state.operation, 'state');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(frames.length, 2);
  send({id: state.id, ok: true});
  assert.deepEqual(await next(frames, 2), {version: 1, operation: 'stopped'});
  assert.deepEqual(await closed, [0, null]);
  assert.equal(frames.length, 3, 'unadmitted next sequence remains available for resume');
});

for (const failure of ['dispatch', 'state', 'eof', 'invalid_ack']) {
  test(`owner stop cannot report success after ${failure} failure`, {timeout: 5000}, async t => {
    const {child, closed, frames, send} = fixture(t);
    const dispatch = await next(frames, 0);
    send({operation: 'stop'});
    if (failure === 'eof') child.stdin.end();
    else if (failure === 'invalid_ack') send({id: dispatch.id + 20, ok: true});
    else if (failure === 'dispatch') send({id: dispatch.id, ok: false});
    else {
      send({id: dispatch.id, ok: true});
      const state = await next(frames, 1);
      send({id: state.id, ok: false});
    }
    const [code] = await closed;
    assert.notEqual(code, 0);
    assert.ok(!frames.some(frame => frame.operation === 'stopped'));
  });
}

test('owner stop bounds a missing dispatch acknowledgement', {timeout: 16000}, async t => {
  const {closed, frames, send} = fixture(t);
  await next(frames, 0);
  const started = Date.now();
  send({operation: 'stop'});
  const [code] = await closed;
  assert.notEqual(code, 0);
  assert.ok(Date.now() - started < 15000);
  assert.ok(!frames.some(frame => frame.operation === 'stopped' || frame.operation === 'state'));
});
