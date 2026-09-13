/**
 * claude 런타임 어댑터.
 *
 * 계약: `../session-usage.mjs` 머리말.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachLine } from '../jsonl.mjs';

export const name = 'claude';

/** 구독제다. 토큰은 기록에 남지만 이 계정에 통화 환산은 없다. */
export const meter = {
  kind: 'subscription',
  unit: null,
  note: '구독이라 통화 환산이 없다. 토큰만 센다.',
};

const BASE = path.join(os.homedir(), '.claude', 'projects');

function* transcripts(dir = BASE, depth = 0) {
  if (depth > 2 || !fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { yield* transcripts(p, depth + 1); continue; }
    if (e.name.endsWith('.jsonl')) yield { file: p, workspace: path.basename(dir) };
  }
}

/**
 * 세션 종류.
 *
 * sidechain 은 자손이다. 그 밖에는 전사본의 `entrypoint` 로 사람인지 가른다 — `claude -p`
 * 로 연 헤드리스 세션이 사람 대화로 잡히면 안전장치가 그것을 절대 안 멈춘다.
 * 모르면 보호하는 쪽으로 둔다.
 */
function classify({ isSidechain, entrypoint }) {
  if (isSidechain) return 'descendant';
  const how = String(entrypoint ?? '').toLowerCase();
  if (how && /print|headless|sdk|non-?interactive/.test(how)) return 'headless';
  return 'interactive';
}

/** 시험용. 상황을 주면 이 런타임이 그것을 어떻게 부르는지 답한다. */
export function classifyFor(situation) {
  if (situation === 'human') return classify({ isSidechain: false, entrypoint: 'cli' });
  if (situation === 'descendant') return classify({ isSidechain: true });
  if (situation === 'scheduled') return null;          // claude 자체에는 예약 개념이 없다
  if (situation === 'worker') return classify({ isSidechain: false, entrypoint: 'print' });
  return null;
}

export function sessions({ sinceMs = 0, untilMs = Infinity } = {}) {
  const out = [];
  for (const { file, workspace } of transcripts()) {
    const st = fs.statSync(file);
    if (st.mtimeMs < sinceMs) continue;
    const tokens = { input: 0, cached: 0, output: 0, reasoning: 0 };
    let calls = 0; let turns = 0; let model = null; let lastAt = 0; let isSidechain = false;
    let entrypoint = null;
    forEachLine(file, (line) => {
      if (!line.includes('"usage"')) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }   // 깨진 줄 하나가 집계를 막지 않는다
      const u = j.message?.usage;
      if (!u) return;
      const at = j.timestamp ? Date.parse(j.timestamp) : 0;
      if (at && (at < sinceMs || at > untilMs)) return;
      const read = u.cache_read_input_tokens || 0;
      const write = u.cache_creation_input_tokens || 0;
      // 공용 모양에서 input 은 캐시를 포함한 전체 입력이다.
      tokens.input += (u.input_tokens || 0) + read + write;
      tokens.cached += read;
      tokens.output += u.output_tokens || 0;
      calls += 1; turns += 1;
      if (j.message?.model) model = j.message.model;
      if (j.isSidechain) isSidechain = true;
      if (!entrypoint && j.entrypoint) entrypoint = j.entrypoint;
      if (at > lastAt) lastAt = at;
    });
    if (!calls) continue;
    out.push({
      runtime: name, id: path.basename(file, '.jsonl'), dir: path.dirname(file), workspace,
      kind: classify({ isSidechain, entrypoint }), scheduled: null, nativeKind: isSidechain ? 'sidechain' : (entrypoint ?? null),
      tokens, calls, turns, notionalUsd: null, lastAt: lastAt || st.mtimeMs, model,
    });
  }
  return out;
}

/** claude 는 세션 id 를 프로세스에 드러내지 않는다. 살아 있는 세션 목록은 제공하지 않는다. */
export function live() { return []; }
