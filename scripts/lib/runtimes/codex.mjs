/**
 * codex 런타임 어댑터.
 *
 * 계약: `../session-usage.mjs` 머리말.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachLine } from '../jsonl.mjs';

export const name = 'codex';

export const meter = {
  kind: 'subscription',
  unit: null,
  note: '구독이라 통화 환산이 없다. 토큰만 센다.',
};

const BASE = path.join(os.homedir(), '.codex', 'sessions');

function* rollouts(dir = BASE, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { yield* rollouts(p, depth + 1); continue; }
    if (e.name.endsWith('.jsonl')) yield p;
  }
}

/**
 * codex 는 줄마다 그 시점까지의 **누적** 사용량(`total_token_usage`)을 적는다.
 * 그래서 더하지 않고 창 안의 마지막 값에서 창 직전 값을 뺀다. 더하면 턴 수만큼 부푼다.
 */
/**
 * 첫 줄의 `session_meta` 가 이 실행이 무엇인지 말해 준다. `source.subagent.thread_spawn`
 * 이 있으면 자손이고, 부모 스레드와 역할 이름까지 적혀 있다. 이것을 안 읽으면 자손 수천
 * 호출이 전부 headless 로 잡혀, 어느 미션이 썼는지 묶을 수 없다.
 */
function meta(file) {
  let head = null;
  forEachLine(file, (line) => { head = line; return false; });
  if (!head) return {};
  let j;
  try { j = JSON.parse(head); } catch { return {}; }
  if (j?.type !== 'session_meta') return {};
  const pay = j.payload ?? {};
  const spawn = pay.source?.subagent?.thread_spawn ?? null;
  return {
    cwd: pay.cwd ?? null,
    originator: pay.originator ?? null,
    parent: spawn?.parent_thread_id ?? null,
    depth: spawn ? Number(spawn.depth ?? 1) : 0,
    agentRole: spawn?.agent_role && spawn.agent_role !== 'None' ? spawn.agent_role : null,
    agentNickname: spawn?.agent_nickname ?? null,
  };
}

export function sessions({ sinceMs = 0, untilMs = Infinity } = {}) {
  const out = [];
  for (const file of rollouts()) {
    const st = fs.statSync(file);
    if (st.mtimeMs < sinceMs) continue;
    let before = null; let last = null; let calls = 0; let model = null; let lastAt = 0;
    forEachLine(file, (line) => {
      if (!line.includes('total_token_usage')) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      const found = findUsage(j);
      if (!found) return;
      const at = j.timestamp ? Date.parse(j.timestamp) : 0;
      if (at && at < sinceMs) { before = found; return; }
      if (at && at > untilMs) return false;
      last = found; calls += 1;
      if (at > lastAt) lastAt = at;
      if (j.payload?.model || j.model) model = j.payload?.model ?? j.model;
      return true;
    });
    if (!last) continue;
    // 누적 카운터는 세션을 이어받거나 되감으면 줄어든다. 그때 뺄셈은 음수가 되므로
    // 기준선을 버리고 마지막 값만 쓴다. 시험이 실제 기록 하나에서 이것을 잡았다.
    const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    let base = before ?? zero;
    const wentBackwards = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']
      .some((k) => (last[k] ?? 0) < (base[k] ?? 0));
    if (wentBackwards) base = zero;
    const tokens = {
      input: Math.max(0, (last.input_tokens ?? 0) - (base.input_tokens ?? 0)),
      cached: Math.max(0, (last.cached_input_tokens ?? 0) - (base.cached_input_tokens ?? 0)),
      output: Math.max(0, (last.output_tokens ?? 0) - (base.output_tokens ?? 0)),
      reasoning: Math.max(0, (last.reasoning_output_tokens ?? 0) - (base.reasoning_output_tokens ?? 0)),
    };
    // 캐시는 입력의 부분집합이라는 공용 약속을 지킨다.
    tokens.cached = Math.min(tokens.cached, tokens.input);
    if (tokens.input <= 0 && tokens.output <= 0) continue;
    const m = meta(file);
    out.push({
      runtime: name, id: path.basename(file, '.jsonl').slice(-36), dir: path.dirname(file),
      file, workspace: m.cwd ?? null,
      kind: m.parent ? 'descendant' : 'headless',
      scheduled: null, nativeKind: m.originator ?? null,
      parent: m.parent ?? null, depth: m.depth ?? 0, agentRole: m.agentRole ?? null,
      tokens, calls, turns: calls, notionalUsd: null, lastAt: lastAt || st.mtimeMs, model,
    });
  }
  return out;
}

function findUsage(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (node.total_token_usage && typeof node.total_token_usage === 'object') return node.total_token_usage;
  for (const v of Object.values(node)) {
    const hit = findUsage(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** codex 는 세션 id 를 프로세스에 드러내지 않는다. */
export function live() { return []; }
