#!/usr/bin/env node
/**
 * 지난 회차 이후 커밋이 있었는가.
 *
 *   #gate: git-has-new-commits [ref] [저장소경로]
 *
 * ref 기본값은 HEAD, 저장소 기본값은 현재 디렉터리입니다.
 * 처음 도는 회차는 비교 대상이 없으므로 진행시킵니다.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { read, write } from './_state.mjs';

const ref = process.argv[2] || 'HEAD';
const repo = path.resolve(process.argv[3] || process.cwd());

let head;
try {
  head = execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8', timeout: 10_000 }).trim();
} catch (error) {
  process.stdout.write(`git rev-parse ${ref} 실패: ${error.message}\n`);
  process.exit(2);
}

const key = `${repo}#${ref}`;
const state = read('git-has-new-commits');
const previous = state[key];

state[key] = { head, at: new Date().toISOString() };
write('git-has-new-commits', state);

if (previous && previous.head === head) {
  process.stdout.write(`${ref} 이 ${head.slice(0, 8)} 에서 그대로입니다.\n`);
  process.exit(1);
}

process.stdout.write(`${ref} ${previous ? `${previous.head.slice(0, 8)} → ` : ''}${head.slice(0, 8)}\n`);
