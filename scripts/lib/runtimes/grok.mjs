/**
 * grok 런타임 어댑터. 벤더 고유의 것은 여기까지만 알고, 바깥은 토큰만 본다.
 *
 * 계약: `../session-usage.mjs` 머리말.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachLine } from '../jsonl.mjs';

export const name = 'grok';

/** 구독제다. 계정 허용량 백분율이 진짜 한도이고, 도구가 내놓는 달러는 명목 환산값이다. */
export const meter = {
  kind: 'subscription',
  unit: '%',
  note: 'SuperGrok Heavy. costUsdTicks 는 도구가 API 요율로 환산한 참고값이며 실제 청구가 아니다.',
};

const ROOT = path.join(os.homedir(), '.grok');
const SESSIONS = path.join(ROOT, 'sessions');
const TICKS_PER_USD = 1e10;   // grok 바이너리가 문서화한 단위. 1e9 로 읽으면 열 배 틀린다.

function* dirs() {
  if (!fs.existsSync(SESSIONS)) return;
  for (const ws of fs.readdirSync(SESSIONS)) {
    const w = path.join(SESSIONS, ws);
    let entries;
    try { entries = fs.readdirSync(w, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      yield { id: e.name, dir: path.join(w, e.name), workspace: decodeURIComponent(ws) };
    }
  }
}

/**
 * 세션 종류. grok 이 적는 `session_kind` 를 공용 어휘로 옮긴다.
 *
 * 예약 작업인지는 세션을 여는 주입 프롬프트로만 판정한다. 대화 도중 예약을 만들거나
 * 이야기한 세션도 같은 문자열을 갖기 때문이다(01a089f4 가 774번째 줄에 갖고 있다).
 * 그래서 앞 네 줄의 system-reminder 안에 있는 것만 센다.
 */
function classify(dir) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')).session_kind ?? null; } catch { /* 없으면 null */ }
  let scheduled = null;
  const chat = path.join(dir, 'chat_history.jsonl');
  if (fs.existsSync(chat)) {
    const fd = fs.openSync(chat, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fs.statSync(chat).size, 262144));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString('utf8', 0, read).split('\n').slice(0, 4).join('\n');
      const m = head.match(/<system-reminder>[^"]{0,40}Scheduled task ([0-9a-f-]{36}) \(every ([^)]+)\)/);
      if (m) scheduled = { id: m[1], every: m[2] };
    } finally { fs.closeSync(fd); }
  }
  let kind = 'interactive';
  if (String(raw).startsWith('subagent')) kind = 'descendant';
  else if (raw === 'headless') kind = 'headless';
  if (scheduled) kind = 'scheduled';
  return { kind, scheduled, nativeKind: raw };
}

/**
 * 턴 레코드를 기간으로 걸러 합산한다.
 *
 * 세션 총계 파일(`usage.json`)은 이어받은 이력과 자식 롤업을 포함해 5.4배 과다 계상하고,
 * 세션당 마지막 레코드 하나만 읽으면 앞 턴이 빠져 과소 계상한다. 계정 사용률과 대조했을 때
 * 이 합산만 96퍼센트로 맞았다(2026-09-12 검증).
 *
 * 줄 전체를 정규식으로 긁지 않는다. 회차가 읽어들인 문서 본문에 같은 글자가 들어 있으면
 * 그것을 비용으로 세고(이 조사 문서를 읽던 세션에서 실제로 걸렸다), 한 줄에 `usage` 와
 * `usage.modelUsage.<모델>` 로 같은 키가 두 벌 있어 자칫 모델별 내역을 총계로 읽는다.
 */
function sum(dir, sinceMs, untilMs) {
  const file = path.join(dir, 'updates.jsonl');
  if (!fs.existsSync(file)) return null;
  const tokens = { input: 0, cached: 0, output: 0, reasoning: 0 };
  let calls = 0; let turns = 0; let notionalUsd = 0; let lastAt = 0; let model = null;
  forEachLine(file, (line) => {
    if (!line.includes('costUsdTicks')) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    const u = record?.params?.update?.usage;
    if (!u || typeof u.costUsdTicks !== 'number') return;
    const at = typeof record.timestamp === 'number' ? record.timestamp * 1000 : 0;
    if (at && (at < sinceMs || at > untilMs)) return;
    tokens.input += u.inputTokens ?? 0;
    tokens.cached += u.cachedReadTokens ?? 0;
    tokens.output += u.outputTokens ?? 0;
    tokens.reasoning += u.reasoningTokens ?? 0;
    calls += u.modelCalls ?? 0;
    notionalUsd += u.costUsdTicks / TICKS_PER_USD;
    turns += 1;
    if (at > lastAt) lastAt = at;
    if (u.modelUsage) model = Object.keys(u.modelUsage)[0] ?? model;
  });
  return { tokens, calls, turns, notionalUsd, lastAt, model };
}

export function sessions({ sinceMs = 0, untilMs = Infinity } = {}) {
  const out = [];
  for (const { id, dir, workspace } of dirs()) {
    const updates = path.join(dir, 'updates.jsonl');
    if (!fs.existsSync(updates)) continue;
    if (fs.statSync(updates).mtimeMs < sinceMs) continue;
    const u = sum(dir, sinceMs, untilMs);
    if (!u || u.turns === 0) continue;
    const { kind, scheduled, nativeKind } = classify(dir);
    out.push({ runtime: name, id, dir, workspace, kind, scheduled, nativeKind, ...u });
  }
  return out;
}

/**
 * 지금 살아 있는 세션과 그 프로세스.
 *
 * `active_sessions.json` 만 믿으면 안 된다. 거기에는 대화형 세션만 적히고, 헤드리스
 * 실행과 예약 루프는 빠진다. 실측으로 확인했다. grok 프로세스 셋이 도는 동안 그 파일에는
 * 하나뿐이었고, 빠진 둘이 바로 감시해야 할 종류였다. 그래서 /proc 에서 프로세스를 찾고
 * 그 프로세스가 열어 둔 `<세션디렉터리>/events.jsonl` 로 세션을 알아낸다.
 */
/** 시험용. 상황을 주면 이 런타임이 그것을 어떻게 부르는지 답한다. */
export function classifyFor(situation) {
  // grok 은 session_kind 와 예약 주입 프롬프트로 가른다. classify() 의 규칙을 그대로 따른다.
  if (situation === 'human') return 'interactive';
  if (situation === 'descendant') return 'descendant';       // session_kind 가 subagent*
  if (situation === 'scheduled') return 'scheduled';         // 앞 4줄의 예약 reminder
  if (situation === 'worker') return 'headless';             // session_kind === 'headless'
  return null;
}

export function live() {
  const found = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
    if (!/(^|\/)grok(\s|$)/.test(cmd)) continue;
    let id = null;
    try {
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        let target = '';
        try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        const m = target.match(/\/\.grok\/sessions\/[^/]+\/([0-9a-f-]{36})\//);
        if (m) { id = m[1]; break; }
      }
    } catch { /* 다른 사용자의 프로세스 */ }
    if (!id) continue;
    let cwd = null;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* 권한 없음 */ }
    // 한 세션에 프로세스가 둘일 수 있다(timeout 래퍼). 더 깊은 쪽, 즉 큰 pid 를 남긴다.
    const prev = found.get(id);
    if (!prev || pid > prev.pid) found.set(id, { runtime: name, id, pid, cwd });
  }
  // 등록 파일에만 있는 것도 합친다. fd 를 못 읽는 경우가 있다.
  let registry = [];
  try { registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'active_sessions.json'), 'utf8')) || []; } catch { /* 없으면 건너뛴다 */ }
  for (const s of registry) {
    if (!s.session_id || !Number.isInteger(s.pid) || s.pid <= 0) continue;
    if (found.has(s.session_id)) continue;
    try { fs.readFileSync(`/proc/${s.pid}/cmdline`); } catch { continue; }
    found.set(s.session_id, { runtime: name, id: s.session_id, pid: s.pid, cwd: s.cwd ?? null });
  }
  return [...found.values()];
}

/** 세션 디렉터리를 id 로 찾는다. */
export function locate(id) {
  for (const s of dirs()) if (s.id === id) return s.dir;
  return null;
}

/** 한 세션의 사용량을 id 로 읽는다. 안전장치가 살아 있는 세션을 볼 때 쓴다. */
export function usageOf(id, { sinceMs = 0, untilMs = Infinity } = {}) {
  const dir = locate(id);
  if (!dir) return null;
  const u = sum(dir, sinceMs, untilMs);
  if (!u) return null;
  const { kind, scheduled, nativeKind } = classify(dir);
  return { runtime: name, id, dir, workspace: null, kind, scheduled, nativeKind, ...u };
}

/** 시험용. 세션 디렉터리 하나의 합산 규칙만 따로 확인한다. */
export const sumForTest = (dir) => sum(dir, 0, Infinity);

/**
 * 계정 계기판. 런타임이 자기 한도를 스스로 보고한다.
 *
 * grok 은 종량 청구가 아니라 구독이고, 계정 단위로 한 달 허용량을 쓴다. 바닥나면 요청이
 * 402 로 거부되어 모든 기기의 작업이 선다. 그러니 명목 달러보다 이 백분율이 정확하고, 이
 * 숫자 하나가 여러 기기의 소비를 합산한 값이다. 2026-09-11 에 100달러 요금제가 꽉 차
 * 300달러로 올렸고 다음 날 8시간 만에 24퍼센트가 더 나갔다. 그래서 총량이 아니라 시간당
 * 소모율과 소진 예정 시각을 본다.
 */
export function meterReading() {
  const log = path.join(ROOT, 'logs', 'unified.jsonl');
  if (!fs.existsSync(log)) return null;
  const series = [];
  let periodStart = null;
  // 로그는 커질 수 있으니 끝에서 8MB 만 본다.
  const size = fs.statSync(log).size;
  const fd = fs.openSync(log, 'r');
  let text;
  try {
    const start = Math.max(0, size - 8 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally { fs.closeSync(fd); }
  for (const line of text.split('\n')) {
    if (!line.includes('creditUsagePercent')) continue;
    const pct = line.match(/"creditUsagePercent":([0-9.]+)/);
    const at = line.match(/"(?:timestamp|time|ts|at)":"?([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:]{8})/);
    const ps = line.match(/"billingPeriodStart":"([^"]+)"/);
    if (ps) periodStart = ps[1];
    if (pct && at) series.push({ at: Date.parse(`${at[1].replace(' ', 'T')}Z`), pct: Number(pct[1]) });
  }
  if (series.length === 0) return null;
  series.sort((a, b) => a.at - b.at);
  const last = series[series.length - 1];
  // 최근 6시간 구간으로 소모율을 잰다. 그만큼의 표본이 없으면 가진 구간 전체로 잰다.
  const windowStart = last.at - 6 * 3600000;
  const first = series.find((s) => s.at >= windowStart) || series[0];
  const hours = (last.at - first.at) / 3600000;
  const perHour = hours > 0.2 ? (last.pct - first.pct) / hours : null;
  const hoursLeft = perHour && perHour > 0 ? (100 - last.pct) / perHour : null;
  return { pct: last.pct, at: last.at, perHour, hoursLeft, periodStart, samples: series.length };
}
