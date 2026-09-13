#!/usr/bin/env node
/**
 * 세션 하나 또는 여럿의 누적 토큰을 찍는다.
 *
 * 계산은 하지 않습니다. `lib/session-usage.mjs` 의 `usageOf` 를 그대로 부르고 합만 냅니다.
 * 같은 값을 두 곳에서 따로 세면 반드시 갈라지므로, 집계는 정본 한 곳에만 둡니다.
 *
 *   node scripts/session-tokens.mjs grok <세션id> [<세션id>...]
 *
 * 일부를 못 찾으면 그 몫만 0 으로 치고 합을 냅니다. **전부** 못 찾으면 종료 코드 3 입니다.
 * "0 을 썼다"와 "모르겠다"를 같은 코드로 내면, 부르는 쪽은 늘 0 을 받아 어떤 상한에도
 * 닿지 않습니다. 값이 설정돼 있고 코드도 도는데 장치만 없는 상태가 됩니다.
 *
 * 지정한 런타임에서만 찾습니다. 못 찾을 때 다른 런타임을 훑어 보게 했다가 한 번 조회에
 * 55초가 걸렸습니다. 빠른 경로가 없는 어댑터는 기록 전수를 읽고, codex 기록 하나가
 * 500MB 를 넘기 때문입니다. 부르는 쪽(관문 훅)의 제한이 20초라 그 조회는 매번 시간을
 * 넘겨 "모르겠다"가 되고, 예산은 영원히 걸리지 않습니다. 느린 정확성이 조용한 무력화가
 * 되는 자리라, 런타임 판정은 환경 변수로 확실히 하고 조회는 한 곳만 봅니다.
 */
import { usageOf, totalTokens, formatTokens } from './lib/session-usage.mjs';

const [runtime, ...ids] = process.argv.slice(2);

if (!runtime || ids.length === 0) {
  process.stderr.write('사용법: session-tokens.mjs <runtime> <세션id>...\n');
  process.exit(2);
}

let total = 0;
let missing = 0;

for (const id of ids) {
  let record = null;
  try { record = usageOf(runtime, id); }
  catch (error) { process.stderr.write(`${runtime}/${id}: ${error.message}\n`); }
  if (!record) { missing += 1; continue; }
  total += totalTokens(record);
}

if (missing) process.stderr.write(`${ids.length} 중 ${missing} 개는 기록을 찾지 못해 0 으로 셌습니다.\n`);

process.stdout.write(`${total}\n`);

// 하나도 못 찾았으면 "0 을 썼다"가 아니라 "모르겠다"다. 둘을 같은 종료 코드로 내면
// 예산 판정이 조용히 무력화된다 — 합계가 늘 0 이니 어떤 상한에도 닿지 않는다.
if (missing === ids.length) process.exit(3);
if (process.env.SESSION_TOKENS_HUMAN) process.stderr.write(`${formatTokens(total)}\n`);
