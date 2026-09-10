import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { engineSnapshotDigest, installEngineSnapshot, verifyEngineSnapshot } from '../runtime/engine-snapshot.mjs';
import { runClaimedBackendTask } from '../runtime/backend-task.mjs';
import { DiscordGatewaySession, MemoryGatewayState } from '../engine/discord/discord-gateway.mjs';
import { postDiscordMessageOnce } from '../adapters/discord/delivery.mjs';
import { redactSecrets } from '../core/redact.mjs';
const id = n => String(n).repeat(18);

async function removeFixture(root) {
 for (let attempt = 0; attempt < 40; attempt += 1) {
  try { rmSync(root, { recursive: true, force: true }); return; }
  catch (error) {
   if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error?.code)) throw error;
   await new Promise(resolve => setTimeout(resolve, 250));
  }
 }
 // Windows can retain a native SQLite handle until the test process starts
 // shutting down. Defer this fixture-only cleanup instead of turning a
 // successful runtime assertion into an EPERM failure.
 if (process.platform === 'win32') {
  process.once('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  return;
 }
 rmSync(root, { recursive: true, force: true });
}

function socketFixture() {
 const listeners = new Map(), sent = [];
 const socket = { addEventListener: (type, listener) => listeners.set(type, listener), send: text => sent.push(JSON.parse(text)), close: () => listeners.get('close')?.({code:1000}) };
 return { socket, sent, emit: payload => listeners.get('message')({data:JSON.stringify(payload)}) };
}

test('slow durable callbacks do not delay ACK and failed callbacks never advance sequence', async () => {
 const io = socketFixture(), state = new MemoryGatewayState({sequence:4});
 let release;
 const hold = new Promise(resolve => release = resolve);
 const session = new DiscordGatewaySession({token:'fixture-credential-value',stateRepository:state,webSocketFactory:()=>io.socket,
  onDispatch:async()=>{await hold; throw Error('commit failed');}});
 session.connect(); session.awaitingHeartbeatAck = true;
 io.emit({op:0,s:5,t:'MESSAGE_CREATE',d:{}});
 await Promise.resolve(); io.emit({op:11}); await Promise.resolve();
 assert.equal(session.awaitingHeartbeatAck,false); assert.equal(state.load().sequence,4);
 release(); await session.drain(); assert.equal(state.load().sequence,4);
});

test('graceful close checkpoints admitted work, invalid-session epoch does not resurrect it', async () => {
 for (const invalidate of [false,true]) {
  const io=socketFixture(),state=new MemoryGatewayState({sequence:4,sessionId:'old'});
  let release; const hold=new Promise(resolve=>release=resolve);
  const session=new DiscordGatewaySession({token:'fixture-credential-value',stateRepository:state,webSocketFactory:()=>io.socket,onDispatch:()=>hold});
  session.connect();io.emit({op:0,s:5,t:'MESSAGE_CREATE',d:{}});await Promise.resolve();
  if(invalidate) {io.emit({op:9,d:false});await Promise.resolve();} else session.close();
  release();await session.drain();assert.equal(state.load().sequence,invalidate?null:5);
 }
});

test('unknown delivery makes exactly one request; registered first-line recipients alone notify', async () => {
 let attempts=0;
 const result=await postDiscordMessageOnce({token:'fixture-credential-value',channelId:id(1),botUserId:id(2),nonce:'on:'+ 'a'.repeat(22),allowedUsers:[id(3)],content:`<@${id(3)}> decision\n<@${id(4)}> quote`,
 fetchImpl:async(_url,options)=>{attempts++;const body=JSON.parse(options.body);assert.deepEqual(body.allowed_mentions,{parse:[],users:[id(3)],replied_user:false});throw Error('after send');}});
 assert.equal(result.state,'unknown');assert.equal(attempts,1);
 for(const content of [`> <@${id(3)}> quoted`,`ordinary\n<@${id(3)}> body`]) {
  await postDiscordMessageOnce({token:'fixture-credential-value',channelId:id(1),nonce:'stable',allowedUsers:[id(3)],content,fetchImpl:async(_url,options)=>{assert.equal(JSON.parse(options.body).allowed_mentions.users,undefined);return{ok:false,status:429};}});
 }
 assert.match(redactSecrets('/opt/private/file /tmp/output /usr/local/private /var/www/app token=hidden-value'), /\[LOCAL_PATH\].*\[REDACTED\]/);
});

test('immutable snapshot contains its complete engine and rejects tamper or symlink', () => {
 const root=mkdtempSync(join(tmpdir(),'messaging-snapshot-'));
 try {
  const sourceRoot=resolve(import.meta.dirname,'..');
  const lock={schemaVersion:1,repository:'nextain/naia-messaging',revision:'a'.repeat(40),snapshotSha256:engineSnapshotDigest(sourceRoot)};
  const destination=join(root,'engine');installEngineSnapshot({sourceRoot,destination,lock});
  assert.ok(existsSync(join(destination,'engine/discord/backend-runner.mjs')));verifyEngineSnapshot(destination,lock);
  writeFileSync(join(destination,'core/redact.mjs'),'throw Error("tampered");');assert.throws(()=>verifyEngineSnapshot(destination,lock),/digest mismatch/);
  rmSync(join(destination,'core/redact.mjs'));
  try {
   symlinkSync(join(sourceRoot,'core/redact.mjs'),join(destination,'core/redact.mjs'));
   assert.throws(()=>verifyEngineSnapshot(destination,lock),/symbolic link/);
  } catch (error) {
   if (!['EACCES','EPERM'].includes(error?.code)) throw error;
   // Windows without Developer Mode cannot create test symlinks. The regular
   // snapshot digest/tamper assertions above still cover this checkout.
  }
 } finally {rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('claimed backend uses the common runner and refuses a second execution after success', async () => {
 const root=mkdtempSync(join(tmpdir(),'messaging-backend-'));
 try {
  const executable=join(root,process.platform==='win32'?'fake-codex.js':'fake-codex');
  writeFileSync(executable,`#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')) { console.log('codex-cli 0.148.0'); process.exit(0); }
if(process.env.DISCORD_BOT_TOKEN || process.env.ONMAM_MESSAGING_ROOT) process.exit(88);
const target=process.argv[process.argv.indexOf('--output-last-message')+1];
process.stdin.resume();process.stdin.on('end',()=>{writeFileSync(target,'verified final');console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));});
`);chmodSync(executable,0o700);
  const input={jobId:'claimed-one',cwd:root,prompt:'fixture',stateRoot:join(root,'state'),executable,model:'fixture-model',reasoningEffort:'max',timeoutMs:10000};
  const options={parentEnv:{...process.env,DISCORD_BOT_TOKEN:'fixture-only',ONMAM_MESSAGING_ROOT:'fixture-config'}};
  const first=await runClaimedBackendTask(input,options);assert.equal(first.status,'ok',JSON.stringify(first));assert.equal(first.resultText,'verified final');
  const second=await runClaimedBackendTask(input,options);assert.equal(second.status,'error');assert.equal(second.kind,'execution_already_recorded');assert.equal(second.execution_started,true);
 } finally {await removeFixture(root);}
});

test('trusted consumers can map legacy credential names without widening profiles', async () => {
 const { registerCredentialProfileAlias, validateCredentialProfiles } = await import('../engine/discord/credential-profiles.mjs');
 registerCredentialProfileAlias('fixture-ssh', 'ssh-ed25519');
 assert.deepEqual(validateCredentialProfiles(['fixture-ssh']), ['ssh-ed25519']);
 assert.throws(() => validateCredentialProfiles(['fixture-ssh', 'ssh-ed25519']));
 assert.throws(() => registerCredentialProfileAlias('fixture-ssh', 'gh'));
 assert.throws(() => registerCredentialProfileAlias('arbitrary-key', '/private/key'));
});
