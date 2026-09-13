/**
 * 모델 세션 사용량을 도구와 무관한 한 모양으로 모으는 자리.
 *
 * 왜 토큰인가. naia 생태계의 목적은 클라우드 독립입니다. 오늘 grok 을 쓰고 내일 우리가
 * 3090 에서 직접 서빙한다면, 달러로 잡아 둔 임계는 그날로 무의미해집니다. 구독제인 claude
 * 와 codex 에는 애초에 달러가 없고, grok 이 내놓는 달러도 도구가 API 요율로 환산한 명목값
 * 입니다. 어느 런타임이 답하든 변하지 않는 것은 토큰이므로, 임계는 토큰으로 잡습니다.
 *
 * 달러와 구독 퍼센트와 GPU 점유는 런타임이 각자 붙이는 **표시 방법**입니다. 종량제 벤더는
 * 요율표를 거쳐 통화로, 구독은 허용량 대비 퍼센트로, 우리가 돌리는 모델은 점유 시간으로
 * 보여 주면 됩니다. 감시 쪽 코드는 그중 무엇도 알 필요가 없습니다.
 *
 * 런타임 어댑터가 갖춰야 하는 것 (`runtimes/*.mjs`):
 *
 *   name                 문자열. 기록과 영수증에 그대로 남는다.
 *   meter                { kind, unit, note }
 *
 *     kind  'subscription' | 'metered' | 'local'
 *     unit  사람에게 보여 줄 표시 단위. **없으면 null 이고, 그때 note 가 이유를 적는다.**
 *           구독이라 통화 환산이 없으면 null, 계정 허용량을 퍼센트로 보여 주면 '%'.
 *           'tokens' 는 쓰지 않는다 — 토큰은 모든 런타임의 공통 단위이지 표시 방법이 아니다.
 *     note  그 계기를 어떻게 읽어야 하는지 한 줄. 특히 숫자가 실제 청구가 아닐 때 밝힌다.
 *   sessions({sinceMs})  아래 세션 레코드의 배열
 *   live()               지금 살아 있는 { id, pid, cwd } 배열. 없으면 빈 배열.
 *
 * 세션 레코드:
 *
 *   { runtime, id, dir, workspace, model, kind, scheduled,
 *     tokens: { input, cached, output, reasoning },   // input 은 cached 를 포함한다
 *     calls, turns, lastAt, notionalUsd }             // notionalUsd 는 없으면 null
 *
 * `kind` 는 런타임이 정하되 아래 넷 중 하나로 맞춥니다. 안전장치가 이 값으로 "멈춰도 되는
 * 것"을 가르기 때문입니다.
 *
 *   'interactive'  사람이 타이핑하고 있다. 어떤 값에서도 멈추지 않는다.
 *   'descendant'   부모가 낳은 자손. 예산 초과 시 멈춰도 된다.
 *   'scheduled'    주기 작업. 멈춰도 된다.
 *   'headless'     비대화식 실행. 멈춰도 된다.
 */
import * as grok from './runtimes/grok.mjs';
import * as claude from './runtimes/claude.mjs';
import * as codex from './runtimes/codex.mjs';
import * as opencode from './runtimes/opencode.mjs';

export const RUNTIMES = { grok, claude, codex, opencode };

/** 멈춰도 되는 종류. 'interactive' 만 빠져 있다. */
export const STOPPABLE_KINDS = new Set(['descendant', 'scheduled', 'headless']);

export const emptyTokens = () => ({ input: 0, cached: 0, output: 0, reasoning: 0 });

/** 한 레코드에서 임계 판정에 쓰는 값. 어느 런타임이든 이 숫자는 존재한다. */
export const totalTokens = (r) => (r.tokens.input ?? 0) + (r.tokens.output ?? 0);

/** 캐시로 읽은 비율. 같은 내용을 다시 실어 보내는 정도를 본다. */
export const cachedShare = (r) => (r.tokens.input ? r.tokens.cached / r.tokens.input : 0);

/** 출력 중 추론 토큰의 비율. 강도 설정이 실제로 걸렸는지를 여기서 본다. */
export const reasoningShare = (r) => (r.tokens.output ? r.tokens.reasoning / r.tokens.output : 0);

export function collect({ sinceMs = 0, runtimes = Object.keys(RUNTIMES) } = {}) {
  const out = [];
  for (const name of runtimes) {
    const rt = RUNTIMES[name];
    if (!rt?.sessions) continue;
    try { out.push(...rt.sessions({ sinceMs })); }
    catch (error) { process.stderr.write(`${name} 세션을 읽지 못했습니다: ${error.message}\n`); }
  }
  return out;
}

/** 지금 살아 있는 세션과 그 프로세스. 런타임마다 알아내는 방법이 다르다. */
export function live({ runtimes = Object.keys(RUNTIMES) } = {}) {
  const out = [];
  for (const name of runtimes) {
    const rt = RUNTIMES[name];
    if (!rt?.live) continue;
    try { out.push(...rt.live()); }
    catch (error) { process.stderr.write(`${name} 실행 중 세션을 읽지 못했습니다: ${error.message}\n`); }
  }
  return out;
}

/**
 * 런타임이 스스로 보고하는 계정 계기판. 구독 백분율이든, 남은 크레딧이든, GPU 점유든
 * 런타임이 정한다. 감시 쪽은 있으면 보여 주고 없으면 토큰 임계만으로 돈다.
 */
export function meterReadings({ runtimes = Object.keys(RUNTIMES) } = {}) {
  const out = {};
  for (const name of runtimes) {
    const rt = RUNTIMES[name];
    if (!rt?.meterReading) continue;
    try { const r = rt.meterReading(); if (r) out[name] = { ...r, meter: rt.meter }; }
    catch { /* 계기판이 없다고 감시가 서면 안 된다 */ }
  }
  return out;
}

/** 살아 있는 세션 하나의 사용량. 런타임이 빠른 길을 주면 그걸 쓰고, 없으면 전수로 찾는다. */
export function usageOf(runtime, id, window = {}) {
  const rt = RUNTIMES[runtime];
  if (!rt) return null;
  if (rt.usageOf) return rt.usageOf(id, window);
  return rt.sessions(window).find((r) => r.id === id) ?? null;
}

/** 사람이 읽을 토큰 표기. 임계도 같은 표기로 받는다. */
export function formatTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** "12M", "500k", "1.5G", "2000000" 을 토큰 수로 읽는다. */
export function parseTokens(value) {
  const m = String(value).trim().match(/^([\d.]+)\s*([kKmMgG]?)$/);
  if (!m) return NaN;
  const scale = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9 }[m[2]];
  return Number(m[1]) * scale;
}
