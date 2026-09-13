/**
 * 주기 작업이 모델을 부르기 전에 싼 조건부터 보게 한다.
 *
 * 2026-09-12 크레딧 급증의 원인은 30분 주기 예약 하나였습니다. 매 발화가 새 세션이라
 * 문맥을 처음부터 다시 싣고, 할 일이 없는 회차도 똑같이 실었습니다. 실험에서 조건을
 * 먼저 보고 아니면 즉시 끝내면 회차당 0.02달러대로 떨어졌습니다.
 *
 * ## 왜 훅이 둘인가
 *
 * `UserPromptSubmit` 하나로 막으려 했다가 grok 문서 원본에서 막혔습니다.
 *
 *   "Only a prompt you typed can be blocked: auto-wake turns (task and subagent
 *    completions, scheduler fires) and subagent sessions run the hook observe-only."
 *   (`~/.grok/docs/user-guide/10-hooks.md:111`)
 *
 * 예약 발화는 바로 그 auto-wake 경로입니다. 훅은 돌지만 `decision: "block"` 은 무시됩니다.
 * 사람이 친 프롬프트만 막을 수 있는데, 사람이 치는 프롬프트에는 지시선이 없습니다.
 * 그러니 그 하나만으로는 사고 경로에서 아무것도 막지 못합니다.
 *
 * `PreToolUse` 는 다릅니다. 서브에이전트 안에서도 `deny` 가 섭니다(`:93`, `:190`).
 * 그래서 두 겹으로 나눴습니다.
 *
 *   UserPromptSubmit  판정하고 결과를 기록한다. 막을 수 있으면 막는다(사람 프롬프트).
 *   PreToolUse        그 세션이 보류로 기록돼 있으면 모든 도구를 거부한다.
 *
 * 보류된 회차에서 모델은 한두 번 답하고 끝납니다. 일을 시작할 수가 없기 때문입니다.
 * 그 한두 번은 공짜가 아니므로 막은 회차의 세션도 토큰 합에 넣습니다. "건너뛰었다"고만
 * 세면 막을수록 예산이 줄지 않는 모양이 됩니다.
 *
 * ## 지시선
 *
 *   #schedule-id: nightly-qa          (선택) 회차를 묶는 이름. 없으면 예약 id 나 본문 해시.
 *   #gate: git-has-new-commits main   (선택) .agents/gates/ 의 조건 스크립트.
 *   #max-fires: 48                    (선택) 총 회차. 0 이면 이 예약을 멈춘다.
 *   #budget-tokens: 20M               (선택) 이 예약이 쓴 토큰 합의 상한.
 *
 * 지시선은 프롬프트 맨 위 연속 구간에만 유효합니다. 예약 발화 앞에 런타임이 붙이는
 * `<system-reminder>` 블록은 벗겨 내고 봅니다.
 *
 * ## 조건 스크립트의 종료 코드
 *
 *   0        할 일이 있다. 진행한다.
 *   1        할 일이 없다. 이번 회차를 건너뛴다.
 *   그 외     판단 실패. 진행하되 연속 실패를 세고, 3회 연속이면 닫으며 알린다.
 *
 * 처음에는 판단 실패를 무조건 진행으로 뒀습니다. 온맘 게이트웨이가 5일 침묵한 사고
 * 때문이었는데, 그 사고의 교훈은 "fail-open" 이 아니라 "감시자는 바깥에" 였습니다.
 * 그리고 9월 12일이 보여 준 것은 돈 쪽 실패도 똑같이 조용하다는 것입니다. 그래서
 * 한 번의 딸꾹질에는 열어 두되, 계속 고장 나면 닫고 사람에게 알립니다.
 *
 * 끄는 법: NAIA_SCHEDULED_GATE=off
 */
const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OFF_VALUES = new Set(["off", "0", "false", "no"]);
const DIRECTIVE = /^\s*#(schedule-id|gate|max-fires|budget-tokens)\s*:\s*(.*)$/;
const GATE_NAME = /^[A-Za-z0-9][\w.-]*$/;
// 예약 이름은 상태 파일의 JSON 키일 뿐 경로가 아니므로 한글도 받는다. 길이만 묶어 둔다.
const SCHEDULE_ID = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u;
const GATE_EXTENSIONS = [".mjs", ".js", ".cjs", ".sh"];
const GATE_TIMEOUT_MS = 30_000;
const USAGE_TIMEOUT_MS = 20_000;
const SESSION_HISTORY = 200;
// 연속 판단 실패 몇 번까지 열어 둘 것인가. 한 번은 통과시키고, 계속되면 닫는다.
const FAILURE_TOLERANCE = 3;
// 보류 기록을 얼마나 들고 있을 것인가. 회차는 한 시간을 넘지 않으므로 하루면 넉넉하다.
const HOLD_TTL_MS = 24 * 60 * 60 * 1000;
// 예약을 지우는 길은 열어 둔다. 소진된 예약을 모델이 스스로 정리할 수 있어야 한다.
const ALWAYS_ALLOWED_TOOLS = new Set(["scheduler_delete", "scheduler_list"]);

const disabled = (env) =>
	OFF_VALUES.has(String((env || process.env).NAIA_SCHEDULED_GATE || "").trim().toLowerCase());

/**
 * 예약 발화의 프롬프트는 저장된 본문 앞에 런타임이 붙인 블록을 달고 옵니다.
 * 그것을 벗기지 않으면 첫 줄이 지시선이 아니라서 지시선을 하나도 못 읽습니다.
 * 벗기면서 그 안의 예약 id 도 같이 집어 옵니다 — 본문 해시보다 안정된 이름입니다.
 */
function stripRuntimePreamble(prompt) {
	const text = String(prompt || "");
	let scheduleTaskId = null;
	const body = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi, (block) => {
		const found = /Scheduled task\s+([0-9a-fA-F][0-9a-fA-F-]{7,})/.exec(block);
		if (found && !scheduleTaskId) scheduleTaskId = found[1];
		return "";
	});
	return { body: body.replace(/^\s*\n/, ""), scheduleTaskId };
}

/**
 * 맨 위 연속 구간의 지시선만 읽는다. 빈 줄은 구간을 끊지 않는다.
 * 알 수 없는 `#이름:` 을 만나면 거기서 멈춘다 — 오타를 조용히 무시하지 않기 위해서다.
 */
function parseDirectives(prompt) {
	const { body: stripped, scheduleTaskId } = stripRuntimePreamble(prompt);
	const lines = stripped.split(/\r?\n/);
	const found = {};
	const unknown = [];
	let consumed = 0;
	for (const line of lines) {
		if (!line.trim()) { consumed += 1; continue; }
		const match = DIRECTIVE.exec(line);
		if (!match) {
			if (/^\s*#[A-Za-z][\w-]*\s*:/.test(line)) unknown.push(line.trim());
			break;
		}
		found[match[1]] = match[2].trim();
		consumed += 1;
	}
	const body = lines.slice(consumed).join("\n").trim();
	return { directives: found, body, unknown, scheduleTaskId, active: Object.keys(found).length > 0 };
}

/** "20M", "500k", "2000000" 을 토큰 수로 읽는다. lib/session-usage.mjs 의 같은 규칙이다. */
function parseTokens(value) {
	const match = String(value).trim().match(/^([\d.]+)\s*([kKmMgG]?)$/);
	if (!match) return NaN;
	const scale = { "": 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9 }[match[2]];
	return Number(match[1]) * scale;
}

/**
 * 회차를 묶는 이름. 우선순위는 명시 → 런타임이 준 예약 id → 본문 해시다.
 * 본문 해시는 프롬프트를 한 글자만 고쳐도 예산이 새로 시작하므로 마지막 수단이다.
 */
function scheduleIdentity(directives, body, scheduleTaskId) {
	const explicit = directives["schedule-id"];
	if (explicit && SCHEDULE_ID.test(explicit)) return explicit;
	if (scheduleTaskId) return `cron-${scheduleTaskId}`;
	return crypto.createHash("sha256").update(String(body).replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

function findRoot(start) {
	let dir = path.resolve(start || process.cwd());
	const stop = path.parse(dir).root;
	while (dir !== stop) {
		if (fs.existsSync(path.join(dir, ".agents", "gates"))) return dir;
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		dir = path.dirname(dir);
	}
	return path.resolve(start || process.cwd());
}

function statePath(env) {
	const source = env || process.env;
	if (source.NAIA_SCHEDULED_GATE_STATE) return source.NAIA_SCHEDULED_GATE_STATE;
	const base = source.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	return path.join(base, "naia", "scheduled-task-gate.json");
}

function emptyState() {
	return { version: 2, schedules: {}, holds: {} };
}

function readState(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object" && parsed.schedules) {
			parsed.holds ??= {};
			return parsed;
		}
	} catch { /* 없거나 깨졌으면 새로 시작한다 */ }
	return emptyState();
}

function writeState(file, state) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

/**
 * 상태 파일을 잠그고 읽어 고쳐 쓴다.
 *
 * 잠금 없이 하면 회차 둘이 겹칠 때 `fires` 증가분 하나가 사라진다. 그러면 회차 상한이
 * 한 칸씩 밀리고, 상한이 있는데도 안 듣는 모양이 된다. 잠금을 못 잡으면 그냥 쓴다 —
 * 여기서 예외를 던지면 훅이 죽고 관문 전체가 사라진다.
 */
function withState(file, mutate) {
	const lock = `${file}.lock`;
	let held = false;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const deadline = Date.now() + 5000;
	while (!held && Date.now() < deadline) {
		try { fs.mkdirSync(lock); held = true; break; }
		catch { /* 남이 쥐고 있다 */ }
		try {
			if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true });
		} catch { /* 그 사이 풀렸다 */ }
		try { cp.execFileSync(process.execPath, ["-e", ""], { timeout: 1000 }); } catch { /* 잠깐 쉬는 용도 */ }
	}
	try {
		const state = readState(file);
		const result = mutate(state);
		writeState(file, state);
		return result;
	} finally {
		if (held) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* 이미 없다 */ } }
	}
}

/** 조건 스크립트를 찾는다. 이름만 받고 경로는 받지 않는다. */
function resolveGate(root, name) {
	if (!GATE_NAME.test(name)) return { error: `조건 이름이 올바르지 않습니다: ${name}` };
	for (const extension of GATE_EXTENSIONS) {
		const candidate = path.join(root, ".agents", "gates", `${name}${extension}`);
		if (fs.existsSync(candidate)) return { path: candidate, extension };
	}
	return { error: `조건 스크립트가 없습니다: .agents/gates/${name}{${GATE_EXTENSIONS.join(",")}}` };
}

function runGate(root, spec, run) {
	const [name, ...args] = String(spec).trim().split(/\s+/);
	const resolved = resolveGate(root, name);
	if (resolved.error) return { proceed: true, failed: true, note: resolved.error };
	const command = resolved.extension === ".sh" ? "bash" : process.execPath;
	const result = run(command, [resolved.path, ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: GATE_TIMEOUT_MS,
		shell: false,
		maxBuffer: 1024 * 1024,
	});
	const said = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "";
	if (result.error) return { proceed: true, failed: true, note: `조건을 판단하지 못했습니다: ${result.error.message}` };
	if (result.status === 0) return { proceed: true, said };
	if (result.status === 1) return { proceed: false, reason: said || `${name}: 할 일이 없습니다` };
	return { proceed: true, failed: true, note: `${name} 이 예상 밖 종료 코드 ${result.status} 를 냈습니다: ${said}` };
}

/**
 * 판정. 부작용이 없다 — 상태를 읽고 무엇을 할지만 정한다.
 * 순서는 싼 것부터다: 회차 수, 토큰 예산, 조건 스크립트.
 */
function decide({ directives, entry, root }, deps) {
	const notes = [];

	const maxFires = directives["max-fires"];
	if (maxFires !== undefined) {
		const limit = Number(maxFires);
		if (!Number.isFinite(limit) || limit < 0) notes.push(`#max-fires 값을 읽지 못했습니다: ${maxFires}`);
		else if (limit === 0) {
			// 0 은 "멈춰라"다. 예전에는 잘못된 값으로 보고 통과시켰다 — 멈추라는 지시가
			// 여는 쪽으로 떨어지는 것은 이 훅이 가질 수 있는 최악의 기본값이다.
			return { proceed: false, reason: "#max-fires 가 0 입니다. 이 예약은 멈춰 있습니다.", notes, exhausted: true };
		} else if (entry.fires >= limit) {
			return { proceed: false, reason: `회차 상한에 도달했습니다 (${entry.fires}/${limit}회).`, notes, exhausted: true };
		}
	}

	const budget = directives["budget-tokens"];
	if (budget !== undefined) {
		const limit = parseTokens(budget);
		if (!Number.isFinite(limit) || limit <= 0) notes.push(`#budget-tokens 값을 읽지 못했습니다: ${budget}`);
		else {
			const spent = deps.spentTokens(entry);
			if (spent === null) notes.push("지난 회차의 토큰을 읽지 못해 예산 판정을 건너뜁니다.");
			else if (spent >= limit) {
				return { proceed: false, reason: `토큰 예산을 다 썼습니다 (${Math.round(spent)}/${limit}).`, notes, spent, exhausted: true };
			}
		}
	}

	const gate = directives.gate;
	if (gate) {
		const outcome = deps.runGate(root, gate);
		if (outcome.note) notes.push(outcome.note);
		if (outcome.failed) {
			const streak = (entry.gateFailures ?? 0) + 1;
			if (streak >= FAILURE_TOLERANCE) {
				return { proceed: false, reason: `조건 판단이 ${streak}회 연속 실패했습니다. 고칠 때까지 멈춥니다.`, notes, gateFailures: streak, alert: true };
			}
			return { proceed: true, notes, gateFailures: streak, alert: true };
		}
		if (!outcome.proceed) return { proceed: false, reason: outcome.reason, notes, gateFailures: 0 };
		if (outcome.said) notes.push(outcome.said);
		return { proceed: true, notes, gateFailures: 0 };
	}

	return { proceed: true, notes };
}

function emptyEntry() {
	return { firstAt: null, lastAt: null, fires: 0, skipped: 0, retiredTokens: 0, gateFailures: 0, sessions: [] };
}

/** 기록해 둔 회차들이 쓴 토큰의 합. 집계는 scripts/lib/session-usage.mjs 가 한다. */
function makeSpentTokens(root, run) {
	return (entry) => {
		const byRuntime = new Map();
		for (const fire of entry.sessions || []) {
			if (!fire.id || !fire.runtime) continue;
			if (!byRuntime.has(fire.runtime)) byRuntime.set(fire.runtime, []);
			byRuntime.get(fire.runtime).push(fire.id);
		}
		if (byRuntime.size === 0) return entry.retiredTokens || 0;
		let total = entry.retiredTokens || 0;
		for (const [runtime, ids] of byRuntime) {
			const result = run(process.execPath, [path.join(root, "scripts", "session-tokens.mjs"), runtime, ...ids], {
				cwd: root,
				encoding: "utf8",
				timeout: USAGE_TIMEOUT_MS,
				shell: false,
				maxBuffer: 4 * 1024 * 1024,
			});
			// 하나도 못 찾으면 session-tokens 가 종료 코드 3 을 낸다. 그것을 0 으로 읽으면
			// 예산이 조용히 무력화되므로, 모른다고 말하게 한다.
			if (result.error || result.status !== 0) return null;
			const value = Number(String(result.stdout || "").trim());
			if (!Number.isFinite(value)) return null;
			total += value;
		}
		return total;
	};
}

/**
 * 봉투와 환경에서 런타임과 세션을 가른다.
 *
 * 봉투의 표기(camelCase/snake_case)로 가르려 했다가 실제 grok 세션에서 틀렸다. grok 의
 * 파일 훅은 Claude 호환으로 snake_case `session_id` 를 보낸다. 대신 grok 은 모든 훅
 * 프로세스에 `GROK_SESSION_ID` 를 심으므로(`10-hooks.md:492`) 그것으로 가른다.
 */
function readEnvelope(raw, env) {
	const source = env || process.env;
	let input = {};
	try { input = JSON.parse(raw || "{}") || {}; } catch { /* 봉투를 못 읽으면 통과시킨다 */ }
	const sessionId = input.sessionId || input.session_id || source.GROK_SESSION_ID || null;
	const runtime = source.NAIA_SCHEDULED_GATE_RUNTIME || (source.GROK_SESSION_ID ? "grok" : "claude");
	const event = input.hook_event_name || input.hookEventName || source.GROK_HOOK_EVENT || null;
	return {
		prompt: input.prompt || "",
		sessionId,
		runtime,
		event,
		toolName: input.tool_name || input.toolName || "",
		cwd: input.cwd || input.workingDirectory || null,
	};
}

/**
 * 사람에게 닿는 자리.
 *
 * 훅의 stderr 는 분리된 백그라운드 서브에이전트에서 아무도 읽지 않습니다. grok 은
 * 실패한 훅만 한 줄 표시하고 성공한 훅의 stderr 는 어디에도 내지 않습니다. 그래서
 * 파일로 남깁니다. 감사 문서가 요구한 "사람에게 알린다"의 최소 형태입니다.
 */
function alert(message) {
	process.stderr.write(`[scheduled-task-gate] ${message}\n`);
	try {
		const dir = path.join(os.homedir(), ".local", "state", "naia");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "scheduled-task-gate.alerts.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
	} catch { /* 알림을 못 남긴다고 판정을 되돌리지는 않는다 */ }
}

/** 오래된 보류 기록을 턴다. */
function pruneHolds(state, now) {
	for (const [id, hold] of Object.entries(state.holds ?? {})) {
		if (now - Date.parse(hold.at || 0) > HOLD_TTL_MS) delete state.holds[id];
	}
}

// ── UserPromptSubmit ──────────────────────────────────────────

function onPrompt(envelope) {
	const parsed = parseDirectives(envelope.prompt);
	for (const line of parsed.unknown) {
		process.stderr.write(`[scheduled-task-gate] 알 수 없는 지시선이라 여기서 읽기를 멈췄습니다: ${line}\n`);
	}
	if (!parsed.active) return;

	const root = findRoot(envelope.cwd || process.env.CLAUDE_PROJECT_DIR);
	const file = statePath();
	const now = new Date().toISOString();
	const identity = scheduleIdentity(parsed.directives, parsed.body, parsed.scheduleTaskId);

	const verdict = withState(file, (state) => {
		pruneHolds(state, Date.now());
		const entry = state.schedules[identity] || emptyEntry();
		const decision = decide(
			{ directives: parsed.directives, entry, root },
			{ spentTokens: makeSpentTokens(root, cp.spawnSync), runGate: (r, g) => runGate(r, g, cp.spawnSync) },
		);

		entry.lastAt = now;
		if (!entry.firstAt) entry.firstAt = now;
		if (decision.gateFailures !== undefined) entry.gateFailures = decision.gateFailures;

		if (decision.proceed) {
			entry.fires += 1;
			if (envelope.sessionId) entry.sessions.push({ id: envelope.sessionId, runtime: envelope.runtime, at: now });
		} else {
			entry.skipped += 1;
			// 두 번째 겹이 읽는 자리다. 예약 발화에서는 아래의 block 이 무시되므로,
			// 이 기록이 없으면 아무것도 막지 못한다.
			if (envelope.sessionId) {
				state.holds[envelope.sessionId] = { identity, reason: decision.reason, exhausted: !!decision.exhausted, at: now };
				// 막은 회차도 세션 목록에 넣는다. grok 이 짚은 자리다. 예약 발화에서는
				// 프롬프트 차단이 무시되므로 모델이 한두 번 불리고, 도구가 막혀 끝난다.
				// 그 한두 번은 실제로 쓴 토큰이다. "건너뛰었다"고만 세면 예산 합에서
				// 빠져, 막을수록 예산이 줄지 않는 모양이 된다.
				entry.sessions.push({ id: envelope.sessionId, runtime: envelope.runtime, at: now, blocked: true });
			}
		}

		while (entry.sessions.length > SESSION_HISTORY) {
			const retired = entry.sessions.shift();
			entry.retiredTokens += makeSpentTokens(root, cp.spawnSync)({ sessions: [retired], retiredTokens: 0 }) || 0;
		}

		state.schedules[identity] = entry;
		return decision;
	});

	for (const note of verdict.notes) process.stderr.write(`[scheduled-task-gate] ${note}\n`);
	if (verdict.alert) alert(`${identity}: ${verdict.reason || verdict.notes.join(" / ")}`);

	if (!verdict.proceed) {
		const reason = `[scheduled-task-gate] ${identity}: ${verdict.reason} 이번 회차는 아무 일도 하지 마십시오.`;
		process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
	}
}

// ── PreToolUse ────────────────────────────────────────────────

/**
 * 보류로 기록된 세션에서는 도구를 거부한다.
 *
 * 예약 발화에서 `UserPromptSubmit` 의 block 이 무시되기 때문에 이 자리가 유일한 벽이다.
 * 예약을 다루는 도구만 열어 둔다 — 소진된 예약은 스스로 정리할 수 있어야 한다.
 */
function onTool(envelope) {
	if (!envelope.sessionId) return;
	const file = statePath();
	if (!fs.existsSync(file)) return;
	const hold = readState(file).holds?.[envelope.sessionId];
	if (!hold) return;
	if (Date.now() - Date.parse(hold.at || 0) > HOLD_TTL_MS) return;

	const tool = String(envelope.toolName || "").split(/[.:/]/).pop();
	if (ALWAYS_ALLOWED_TOOLS.has(tool)) return;

	const tail = hold.exhausted
		? " 이 예약은 소진됐습니다. 더 돌 필요가 없으면 scheduler_delete 로 지우십시오."
		: "";
	process.stdout.write(`${JSON.stringify({
		decision: "deny",
		reason: `[scheduled-task-gate] ${hold.identity}: ${hold.reason} 이번 회차는 아무 일도 하지 말고 한 줄로 끝내십시오.${tail}`,
	})}\n`);
}

function main() {
	if (disabled()) return;
	const raw = fs.readFileSync(0, "utf8");
	const envelope = readEnvelope(raw);
	const event = process.argv[2] || envelope.event || "UserPromptSubmit";
	const normalized = String(event).toLowerCase().replace(/_/g, "");
	if (normalized === "pretooluse") return onTool(envelope);
	if (normalized === "userpromptsubmit") return onPrompt(envelope);
}

module.exports = {
	parseDirectives, stripRuntimePreamble, parseTokens, scheduleIdentity,
	decide, resolveGate, runGate, readEnvelope, emptyEntry, emptyState,
	onPrompt, onTool, withState, statePath,
};

if (require.main === module) {
	try { main(); }
	catch (error) {
		// 이 훅이 사람의 일을 막는 일은 없어야 한다.
		process.stderr.write(`[scheduled-task-gate] ${error && error.message}\n`);
	}
}
