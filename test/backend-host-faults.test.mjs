import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { runClaimedBackendTask } from '../runtime/backend-task.mjs';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'messaging-host-fault-'));
 const executable=join(root,'fake-codex');
 writeFileSync(executable,`#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
if(process.argv.includes('--version')) { console.log('codex-cli 0.148.0');process.exit(0); }
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);
process.stdin.on('end',()=>{
 const finalPath=process.argv[process.argv.indexOf('--output-last-message')+1];
 if(prompt==='wait') {
  process.on('SIGTERM',()=>{});
  const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
  writeFileSync('pids.json',JSON.stringify([process.pid,grandchild.pid]));setInterval(()=>{},1000);return;
 }
 if(prompt==='array') console.log('[1]');
 if(prompt==='item') console.log(JSON.stringify({type:'item.completed',item:7}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'intermediate'}}));
 if(prompt!=='missing') writeFileSync(finalPath,prompt==='empty'?'':'verified final');
 console.log(JSON.stringify({type:'turn.completed',usage:prompt==='usage'?[]:{input_tokens:1,output_tokens:1}}));
});
`);chmodSync(executable,0o700);
 const input={jobId:'fixture-job',cwd:root,prompt:'good',stateRoot:join(root,'state'),executable,model:'fixture-model',reasoningEffort:'max',timeoutMs:10000};
 return {root,input};
}

for(const failure of ['array','item','usage','missing','empty']) {
 test(`host rejects ${failure} output without publishing intermediate text`,async()=>{
  const {root,input}=fixture();
  try {
   const result=await runClaimedBackendTask({...input,prompt:failure});
   assert.equal(result.status,'error',JSON.stringify(result));assert.equal(result.resultText,undefined);
   if(['missing','empty'].includes(failure)) assert.equal(result.kind,'invalid_final_reply');
  } finally {rmSync(root,{recursive:true,force:true});}
 });
}

async function until(predicate) {
 for(let index=0;index<150;index++) {if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}
 assert.fail('bounded process cleanup did not complete');
}
function stopped(pid) {
 try { const stat=readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[0]==='Z'; }
 catch(error) {if(error.code==='ENOENT')return true;throw error;}
}
for(const stop of ['eof','SIGTERM','SIGKILL']) {
 test(`private host ${stop} stops backend and its SIGTERM-ignoring grandchild`,{skip:process.platform!=='linux'},async()=>{
  const {root,input}=fixture();let child;let pids=[];
  try {
   child=spawn(process.execPath,[resolve(import.meta.dirname,'../runtime/host-bridge.mjs'),'backend'],{env:process.env,stdio:['pipe','pipe','pipe']});
   let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();
   child.stdin.write(JSON.stringify({version:1,operation:'backend',input:{...input,prompt:'wait'}})+'\n');
   await until(()=>existsSync(join(root,'pids.json')));
   pids=JSON.parse(readFileSync(join(root,'pids.json')));
   if(stop==='eof')child.stdin.end();else child.kill(stop);
   await until(()=>pids.every(stopped));
   await until(()=>child.exitCode!==null||child.signalCode!==null);
   assert.ok(!output.includes('"status":"ok"'));
   const replay=await runClaimedBackendTask(input);assert.equal(replay.kind,'execution_already_recorded');
  } finally {
   if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');
   // Only fixture PIDs with still-matching ownership are left to their guardian;
   // normal cleanup must pass above before the temporary ledger is discarded.
   rmSync(root,{recursive:true,force:true});
  }
 });
}

for (const [stage, cleanupCall] of [['version probe', 1], ['backend execution', 2]]) {
 test(`host refuses success when ${stage} cleanup is unconfirmed`, {skip:process.platform!=='linux'}, async()=>{
  const {root,input}=fixture();
  try {
   const packageRoot=join(root,'package');
   for(const name of ['engine','runtime','core','adapters']) cpSync(resolve(import.meta.dirname,'..',name),join(packageRoot,name),{recursive:true});
   const ownedPath=join(packageRoot,'engine/discord/backend-owned-process.mjs');
   const source=readFileSync(ownedPath,'utf8').replace('export async function killAndWaitForChild(', 'async function actualCleanup(');
   writeFileSync(ownedPath,source+`\nlet cleanupCalls=0;\nexport async function killAndWaitForChild(...args) { const result=await actualCleanup(...args); return ++cleanupCalls === ${cleanupCall} ? false : result; }\n`);
   const {runClaimedBackendTask:run}=await import(pathToFileURL(join(packageRoot,'runtime/backend-task.mjs')).href);
   const result=await run(input);
   assert.equal(result.status,'error',JSON.stringify(result));
   assert.equal(result.resultText,undefined);
   assert.equal(result.kind,cleanupCall===1?'backend_version_probe_failed':'owned_cleanup_unconfirmed');
   if(cleanupCall===2) assert.notEqual(result.lifecycle,'succeeded');
  } finally {rmSync(root,{recursive:true,force:true});}
 });
}
