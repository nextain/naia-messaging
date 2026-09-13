/**
 * OpenCode 어댑터 — 예약 작업 관문.
 *
 * opencode 는 자체 훅 레지스트리가 없고 프로젝트 플러그인이 그 자리를 대신합니다.
 * `session-contract-gate.js` 와 같은 방식입니다. 정책은 여기서 새로 쓰지 않고
 * `.claude/hooks/scheduled-task-gate.js` 를 그대로 불러다 씁니다. 판정 규칙을 두 벌
 * 두면 반드시 갈라지고, 그러면 런타임마다 다르게 막히는 하네스가 됩니다.
 *
 * 관문이 두 겹인 이유는 grok 쪽 제약 때문입니다. 예약 발화에서 프롬프트 차단이 관측
 * 전용이라(`10-hooks.md:111`) 도구 거부가 유일한 벽입니다. opencode 에는 그 제약이
 * 없지만 같은 두 겹을 유지합니다. 런타임마다 구조가 다르면 어느 쪽이 실제로 막는지
 * 사람이 매번 다시 따져야 합니다.
 *
 *   chat.message          판정하고 결과를 상태 파일에 기록한다
 *   tool.execute.before   그 세션이 보류로 기록돼 있으면 도구를 막는다
 *
 * opencode 는 거부를 예외로 표현합니다. `session-contract-gate.js` 가 쓰는 방식과
 * 같습니다.
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const GATE_RELATIVE = path.join(".claude", "hooks", "scheduled-task-gate.js");

/** 훅 파일이 있는 가장 가까운 조상을 찾는다. 중첩 체크아웃에서도 서야 한다. */
function findHarnessRoot(start) {
	let dir = path.resolve(start || process.cwd());
	const stop = path.parse(dir).root;
	while (dir !== stop) {
		if (fs.existsSync(path.join(dir, GATE_RELATIVE))) return dir;
		dir = path.dirname(dir);
	}
	return null;
}

/** 사용자 메시지의 텍스트를 모은다. parts 모양은 버전마다 달라질 수 있어 방어적으로 읽는다. */
function promptText(output) {
	const parts = output?.parts;
	if (!Array.isArray(parts)) return String(output?.message?.text ?? "");
	const chunks = [];
	for (const part of parts) {
		if (!part) continue;
		if (typeof part === "string") { chunks.push(part); continue; }
		if (typeof part.text === "string") { chunks.push(part.text); continue; }
		if (part.type === "text" && typeof part.content === "string") chunks.push(part.content);
	}
	return chunks.join("\n");
}

/**
 * 관문의 stdout 을 받아 낸다.
 *
 * 관문 본체는 호스트 훅 계약대로 판정을 stdout 에 JSON 으로 씁니다. opencode 는 거부를
 * 예외로 표현하므로 그 출력을 여기서 받아 옮깁니다. 본체를 고치지 않는 이유는, 고치면
 * Claude·grok 쪽 계약이 깨지고 런타임마다 다른 본체가 생기기 때문입니다.
 */
function capture(run) {
	const original = process.stdout.write;
	let said = "";
	process.stdout.write = (chunk) => { said += String(chunk); return true; };
	try { run(); }
	catch (error) { process.stderr.write(`[scheduled-task-gate] ${error?.message || error}\n`); }
	finally { process.stdout.write = original; }
	return said;
}

export const ScheduledTaskGate = async ({ directory }, options = {}) => {
	const root = options.root || findHarnessRoot(directory);
	const load = () => options.gate || require(path.join(root, GATE_RELATIVE));

	return {
		"chat.message": async (input, output) => {
			if (!root) return;
			let gate;
			try { gate = load(); } catch { return; }   // 관문이 없는 저장소에서는 아무 일도 하지 않는다
			// onPrompt 는 차단 판정을 stdout 으로 낸다. opencode 에서 프롬프트를 막는 계약이
			// 없으므로 여기서는 기록만 남기고 출력은 삼킨다. 실제 집행은 아래 도구 쪽이 한다.
			capture(() => gate.onPrompt({
				prompt: promptText(output),
				sessionId: input?.sessionID ?? null,
				runtime: "opencode",
				cwd: directory,
			}));
		},

		"tool.execute.before": async (input) => {
			if (!root) return;
			let gate;
			try { gate = load(); } catch { return; }

			// onTool 은 stdout 으로 판정을 낸다. opencode 는 예외로 거부하므로 여기서 가로챈다.
			const said = capture(() => gate.onTool({
				sessionId: input?.sessionID ?? null,
				toolName: input?.tool ?? "",
				runtime: "opencode",
			}));

			if (!said.trim()) return;
			let verdict;
			try { verdict = JSON.parse(said); } catch { return; }
			if (verdict?.decision === "deny") throw new Error(verdict.reason || "[scheduled-task-gate] blocked");
		},
	};
};
