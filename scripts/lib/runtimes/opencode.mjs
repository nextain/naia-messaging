/**
 * OpenCode 런타임 어댑터.
 *
 * 왜 필요한가. 2026-09-13 에 루크가 짚었습니다. 온맘 게이트웨이를 grok 에서 OpenCode 로
 * 옮길 때 "비용 걱정이 없어지는 것보다 **하네스가 똑같이 동작하는 것**이 더 중요하다".
 * 관문과 가드를 Claude 와 grok 에만 걸어 두면, 런타임을 바꾸는 순간 장치가 전부 사라집니다.
 * 그것은 벤더 중립이 아니라 벤더 세 개에 각각 붙인 것입니다.
 *
 * 이 어댑터가 토큰 계측의 세 번째 축입니다. 관문 쪽 축은
 * `.opencode/plugins/scheduled-task-gate.js` 입니다.
 *
 * ## 여기가 토큰 계측의 이유를 가장 잘 보여 준다
 *
 * OpenCode 세션의 `cost` 컬럼은 **0 입니다.** Azure Foundry 는 별도 계정으로 청구되고
 * OpenCode 는 그 요율을 모르기 때문입니다. 달러로 임계를 잡았다면 이 런타임의 세션은
 * 어떤 상한에도 닿지 않습니다. 토큰은 누가 답하든 남습니다.
 *
 * ## 기록 위치
 *
 * grok 이나 claude 와 달리 JSONL 이 아니라 SQLite 입니다
 * (`~/.local/share/opencode/opencode.db`). `session` 테이블이 세션당 토큰을 컬럼으로
 * 들고 있어 오히려 읽기 쉽습니다. 읽기 전용으로만 엽니다 — 계측이 호스트를 건드리면
 * 안 됩니다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const name = 'opencode';

export const meter = {
  kind: 'metered',
  // 표시 단위가 없다. 제공자 계정에서 따로 청구되고 OpenCode 는 그 요율을 모른다.
  unit: null,
  note: 'Azure Foundry 등 제공자 계정으로 따로 청구된다. OpenCode 가 요율을 모르므로 cost 는 0 으로 남고, 토큰만 정본이다. 달러로 임계를 잡으면 이 런타임의 세션은 어떤 상한에도 닿지 않는다.',
};

const DB = process.env.OPENCODE_DB
  || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');

function open() {
  if (!fs.existsSync(DB)) return null;
  try { return new DatabaseSync(DB, { readOnly: true }); }
  catch { return null; }   // 호스트가 쓰는 중이면 못 열 수 있다. 계측이 호스트를 막지 않는다.
}

/** `model` 컬럼은 JSON 문자열이다. 사람이 읽을 한 줄로 만든다. */
function modelName(raw) {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return m.providerID ? `${m.providerID}/${m.id}` : (m.id ?? null);
  } catch { return String(raw).slice(0, 60); }
}

/**
 * 세션 종류. 안전장치가 이 값으로 "멈춰도 되는 것"을 가른다.
 *
 * `parent_id` 가 있으면 자손이다. OpenCode 에는 예약 개념이 없으므로 `scheduled` 는 나오지
 * 않는다 — 주기 작업은 바깥(systemd, 또는 게이트웨이)이 띄우고, 그 경우 이 프로세스는
 * 헤드리스다. 사람이 TUI 로 여는 세션만 interactive 다.
 */
/**
 * 세션 종류.
 *
 * **기록만으로는 사람과 워커를 못 가릅니다.** 최근 14일 152/155 세션이 `agent = "build"`
 * 인데, 사람이 TUI 로 여는 것도 자동화가 띄우는 것도 같은 이름을 씁니다(제목이
 * `adk-adversarial-review` 인 자동 리뷰 세션도 `build` 입니다).
 *
 * 2026-09-13 grok 적대리뷰가 "게이트웨이 워커가 `interactive` 로 보호된다"고 짚었고,
 * 그래서 `build` 를 `headless` 로 옮겼다가 되돌렸습니다. 그러면 사람 세션 152개가 전부
 * 정지 대상이 됩니다 — 반대 방향으로 더 크게 틀립니다.
 *
 * 그래서 여기서는 **모르면 보호**하고, 실제 정지 판단은 안전장치가 살아 있는 프로세스의
 * 단말 연결 여부로 내립니다(`ai-session-guard.mjs`). 기록이 못 가르는 것을 기록으로
 * 가르려 하지 않습니다.
 */
function classify(row) {
  if (row.parent_id) return 'descendant';
  return 'interactive';
}

/** 시험용. 상황을 주면 이 런타임이 그것을 어떻게 부르는지 답한다. */
export function classifyFor(situation) {
  if (situation === 'human') return classify({});
  if (situation === 'descendant') return classify({ parent_id: 'p1' });
  if (situation === 'scheduled') return null;   // opencode 에 예약 개념이 없다
  // 워커는 기록만으로 못 가른다. 거짓으로 답하지 않고 모른다고 한다 — 안전장치가
  // 단말 연결로 가른다.
  if (situation === 'worker') return null;
  return null;
}

function toRecord(row, calls) {
  const input = (row.tokens_input ?? 0) + (row.tokens_cache_read ?? 0) + (row.tokens_cache_write ?? 0);
  return {
    runtime: name,
    id: row.id,
    dir: row.directory ?? null,
    workspace: row.directory ?? null,
    model: modelName(row.model),
    kind: classify(row),
    scheduled: null,
    nativeKind: row.agent ?? null,
    tokens: {
      // 계약: input 은 cached 를 포함한다. OpenCode 는 셋을 따로 세므로 여기서 합친다.
      input,
      cached: row.tokens_cache_read ?? 0,
      output: row.tokens_output ?? 0,
      reasoning: row.tokens_reasoning ?? 0,
    },
    calls,
    turns: calls,
    lastAt: row.time_updated ?? 0,
    // 0 을 "공짜"로 읽으면 안 된다. 모르는 것이므로 null 로 낸다.
    notionalUsd: row.cost ? row.cost : null,
  };
}

const SELECT = `SELECT id, directory, title, agent, model, cost, parent_id,
  tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
  time_created, time_updated FROM session`;

export function sessions({ sinceMs = 0, untilMs = Infinity } = {}) {
  const db = open();
  if (!db) return [];
  try {
    const rows = db.prepare(`${SELECT} WHERE time_updated >= ? AND time_updated <= ?`)
      .all(sinceMs, Number.isFinite(untilMs) ? untilMs : Number.MAX_SAFE_INTEGER);
    const countOf = db.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?');
    const out = [];
    for (const row of rows) {
      const tokens = (row.tokens_input ?? 0) + (row.tokens_output ?? 0);
      if (tokens === 0) continue;   // 열기만 하고 아무것도 안 한 세션은 세지 않는다
      let calls = 0;
      try { calls = countOf.get(row.id)?.n ?? 0; } catch { /* 메시지가 없으면 0 */ }
      out.push(toRecord(row, calls));
    }
    return out;
  } finally { db.close(); }
}

/** 세션 하나를 id 로 읽는다. 전수 스캔 없이 바로 찾는다. */
export function usageOf(id) {
  const db = open();
  if (!db) return null;
  try {
    const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
    if (!row) return null;
    let calls = 0;
    try { calls = db.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?').get(id)?.n ?? 0; } catch { /* 없으면 0 */ }
    return toRecord(row, calls);
  } finally { db.close(); }
}

/**
 * 지금 살아 있는 세션.
 *
 * OpenCode 는 `active_sessions` 같은 파일을 두지 않으므로 프로세스를 훑는다. 세션 id 를
 * 프로세스에서 직접 알아낼 방법이 없어 작업 디렉터리만 돌려준다. 안전장치는 이것으로
 * "지금 도는 것이 있다"까지만 알 수 있고, 어느 세션인지는 기록 쪽에서 맞춰야 한다.
 */
/**
 * 그 프로세스가 단말에 붙어 있는가.
 *
 * 기록이 사람과 워커를 못 가를 때 쓰는 마지막 신호입니다. `/proc/<pid>/stat` 의 7번째
 * 필드가 제어 단말이고, 0 이면 단말이 없다 — 사람이 보고 있지 않다는 뜻입니다.
 * 읽지 못하면 null 을 내어 "모른다"를 0 과 구분합니다.
 */
export function hasTerminal(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 에 공백이 들어갈 수 있으므로 마지막 ')' 뒤부터 센다
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const tty = Number(fields[4]);   // state, ppid, pgrp, session, tty_nr
    return Number.isFinite(tty) ? tty !== 0 : null;
  } catch { return null; }
}

export function live() {
  const out = [];
  let pids;
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const pid of pids) {
    let cmdline;
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    const argv = cmdline.split('\0').filter(Boolean);
    if (!argv.length) continue;
    const leaf = path.basename(argv[0]);
    const isOpencode = leaf === 'opencode' || argv.some((a) => a.endsWith('/opencode') || a === 'opencode');
    if (!isOpencode) continue;
    let cwd = null;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* 권한이 없으면 생략 */ }
    // runtime 을 넣지 않으면 가드가 어느 어댑터에 물을지 모른다.
    out.push({ runtime: name, id: null, pid: Number(pid), cwd, attended: hasTerminal(pid) });
  }
  return out;
}
