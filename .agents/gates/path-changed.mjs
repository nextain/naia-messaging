#!/usr/bin/env node
/**
 * 지정한 경로들이 지난 회차 이후 바뀌었는가.
 *
 *   #gate: path-changed <경로> [경로...]
 *
 * 디렉터리는 한 겹만 봅니다. 깊은 트리를 통째로 훑는 것은 싼 검사가 아닙니다.
 * 없는 경로는 "없음"이라는 관측이므로, 생겼다가 사라진 것도 변화로 셉니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { read, write } from './_state.mjs';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stdout.write('볼 경로가 없습니다.\n');
  process.exit(2);
}

function stamp(target) {
  let stat;
  try { stat = fs.statSync(target); } catch { return 'absent'; }
  if (!stat.isDirectory()) return `${stat.mtimeMs}:${stat.size}`;
  let newest = stat.mtimeMs;
  let count = 0;
  for (const name of fs.readdirSync(target)) {
    try {
      const child = fs.statSync(path.join(target, name));
      newest = Math.max(newest, child.mtimeMs);
      count += 1;
    } catch { /* 도는 사이에 사라진 항목 */ }
  }
  return `${newest}:${count}`;
}

const observed = Object.fromEntries(targets.map((t) => [path.resolve(t), stamp(path.resolve(t))]));
const key = targets.map((t) => path.resolve(t)).sort().join('|');
const state = read('path-changed');
const previous = state[key];

state[key] = { observed, at: new Date().toISOString() };
write('path-changed', state);

if (!previous) {
  process.stdout.write(`${targets.length} 개 경로의 첫 관측입니다.\n`);
  process.exit(0);
}

const moved = Object.keys(observed).filter((p) => previous.observed?.[p] !== observed[p]);
if (moved.length === 0) {
  process.stdout.write(`${targets.length} 개 경로가 그대로입니다.\n`);
  process.exit(1);
}
process.stdout.write(`${moved.length} 개 경로가 바뀌었습니다: ${moved.map((p) => path.basename(p)).join(', ')}\n`);
