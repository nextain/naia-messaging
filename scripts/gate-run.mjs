#!/usr/bin/env node
/**
 * 조건이 맞을 때만 명령을 돌린다. 주기 작업을 프로세스 기동 앞에서 끊는 자리.
 *
 * 예약 관문(`.claude/hooks/scheduled-task-gate.js`)은 모델 런타임 안에서 돕니다. 그래서
 * systemd 타이머나 cron 이 모델 CLI 를 직접 부르는 경우에는 닿지 않습니다. 그런 작업은
 * 이미 프로세스가 뜬 뒤에야 훅이 돌기 때문에, 문맥 적재 비용을 이미 낸 상태입니다.
 *
 * 이 도구는 그 앞에 섭니다. 조건 스크립트를 먼저 돌리고, 할 일이 없으면 **모델 CLI 를
 * 아예 띄우지 않습니다.** 모델 호출이 0 이므로 절감이 가장 큽니다.
 *
 *   node scripts/gate-run.mjs <조건이름> [조건인자...] -- <명령> [명령인자...]
 *
 * systemd 유닛에서는 ExecStart 를 이렇게 감쌉니다.
 *
 *   ExecStart=/usr/bin/node /var/home/luke/alpha-adk/scripts/gate-run.mjs \
 *       git-has-new-commits HEAD /var/home/luke/dev -- /path/to/run-triage.sh
 *
 * 조건 스크립트의 계약은 `.agents/gates/README.md` 와 같습니다.
 *
 *   0        할 일이 있다 → 명령을 돌린다
 *   1        할 일이 없다 → 돌리지 않고 종료 코드 0 으로 끝낸다
 *   그 외     판단 실패 → 돌린다. 연속 실패를 세고 3회면 멈추며 알린다
 *
 * 건너뛴 것을 종료 코드 0 으로 내는 이유는, systemd 가 실패로 읽으면 그 유닛이 "Failed" 로
 * 쌓여 진짜 실패와 구분되지 않기 때문입니다. 온맘 검사기가 15일간 발견을 보고했는데
 * `exit 1` 이 "Failed" 로 읽혀 아무도 안 본 사고가 있었습니다.
 *
 * 무엇을 했는지는 `$XDG_STATE_HOME/naia/gate-run.json` 에 남습니다.
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE_NAME = /^[A-Za-z0-9][\w.-]*$/;
const GATE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.sh'];
const GATE_TIMEOUT_MS = 60_000;
const FAILURE_TOLERANCE = 3;

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split < 1 || split === argv.length - 1) {
  process.stderr.write('사용법: gate-run.mjs <조건이름> [조건인자...] -- <명령> [인자...]\n');
  process.exit(2);
}
const [gateName, ...gateArgs] = argv.slice(0, split);
const [command, ...commandArgs] = argv.slice(split + 1);

const stateFile = process.env.NAIA_GATE_RUN_STATE
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'naia', 'gate-run.json');

const label = `${gateName} -- ${path.basename(command)}`;

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* 없으면 새로 */ }
  return { version: 1, runs: {} };
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  } catch (error) { process.stderr.write(`상태를 쓰지 못했습니다: ${error.message}\n`); }
}

/** 사람에게 닿는 자리. 타이머의 stderr 는 저널에 묻힌다. */
function alert(message) {
  process.stderr.write(`[gate-run] ${message}\n`);
  try {
    const dir = path.join(os.homedir(), '.local', 'state', 'naia');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gate-run.alerts.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch { /* 알림 실패가 판정을 되돌리지는 않는다 */ }
}

function resolveGate(name) {
  if (!GATE_NAME.test(name)) return { error: `조건 이름이 올바르지 않습니다: ${name}` };
  for (const extension of GATE_EXTENSIONS) {
    const candidate = path.join(ROOT, '.agents', 'gates', `${name}${extension}`);
    if (fs.existsSync(candidate)) return { path: candidate, extension };
  }
  return { error: `조건 스크립트가 없습니다: .agents/gates/${name}` };
}

const state = readState();
const entry = state.runs[label] ?? { ran: 0, skipped: 0, failures: 0, lastAt: null, lastOutcome: null };
const now = new Date().toISOString();
entry.lastAt = now;

const resolved = resolveGate(gateName);
let proceed = true;
let reason = '';

if (resolved.error) {
  entry.failures += 1;
  reason = resolved.error;
  if (entry.failures >= FAILURE_TOLERANCE) {
    proceed = false;
    alert(`${label}: ${reason} — ${entry.failures}회 연속이라 멈춥니다`);
  } else {
    alert(`${label}: ${reason} — 이번에는 그냥 돌립니다`);
  }
} else {
  const runner = resolved.extension === '.sh' ? 'bash' : process.execPath;
  const result = cp.spawnSync(runner, [resolved.path, ...gateArgs], {
    cwd: ROOT, encoding: 'utf8', timeout: GATE_TIMEOUT_MS, shell: false, maxBuffer: 1024 * 1024,
  });
  const said = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || '';

  if (result.error || (result.status !== 0 && result.status !== 1)) {
    entry.failures += 1;
    reason = result.error ? `조건을 판단하지 못했습니다: ${result.error.message}` : `예상 밖 종료 코드 ${result.status}: ${said}`;
    if (entry.failures >= FAILURE_TOLERANCE) {
      proceed = false;
      alert(`${label}: ${reason} — ${entry.failures}회 연속이라 멈춥니다`);
    } else {
      alert(`${label}: ${reason} — 이번에는 그냥 돌립니다`);
    }
  } else {
    entry.failures = 0;
    proceed = result.status === 0;
    reason = said;
  }
}

if (!proceed) {
  entry.skipped += 1;
  entry.lastOutcome = 'skipped';
  state.runs[label] = entry;
  writeState(state);
  process.stdout.write(`건너뜀: ${reason || '할 일이 없습니다'}\n`);
  // systemd 가 실패로 읽지 않도록 0 으로 끝낸다.
  process.exit(0);
}

entry.ran += 1;
entry.lastOutcome = 'ran';
state.runs[label] = entry;
writeState(state);
if (reason) process.stdout.write(`진행: ${reason}\n`);

const child = cp.spawnSync(command, commandArgs, { stdio: 'inherit', shell: false });
if (child.error) {
  process.stderr.write(`명령을 실행하지 못했습니다: ${child.error.message}\n`);
  process.exit(127);
}
process.exit(child.status ?? 0);
