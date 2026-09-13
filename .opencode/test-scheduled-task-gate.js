#!/usr/bin/env node
/**
 * OpenCode 예약 관문 플러그인의 시험.
 *
 * 증명해야 하는 것은 하나입니다. **런타임이 바뀌어도 같은 프롬프트가 같은 판정을 받는가.**
 * 그래서 이 시험은 플러그인이 도는지만 보지 않고, Claude·grok 쪽 본체가 내는 판정과
 * opencode 쪽 판정이 **같은 상태 파일에 같은 모양으로 남는지**를 봅니다.
 *
 * 런타임마다 다르게 막히면 하네스가 아니라 우연입니다.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ScheduledTaskGate } = await import(path.join(ROOT, ".opencode", "plugins", "scheduled-task-gate.js"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gate-"));
process.on("exit", () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 정리 실패는 결과가 아니다 */ } });

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const PROMPT = "#schedule-id: 오픈코드검증\n#max-fires: 0\n\n무엇이든 하라\n";
const message = (text) => ({ message: { role: "user" }, parts: [{ type: "text", text }] });

/** 상태 파일을 갈아 끼우고 플러그인을 새로 만든다. 시험끼리 상태를 나눠 갖지 않는다. */
async function freshPlugin(stateFile) {
	process.env.NAIA_SCHEDULED_GATE_STATE = stateFile;
	return ScheduledTaskGate({ directory: ROOT });
}

test("판정이 상태 파일에 기록된다 (chat.message)", async () => {
	const stateFile = path.join(work, "record.json");
	const plugin = await freshPlugin(stateFile);
	await plugin["chat.message"]({ sessionID: "oc-1" }, message(PROMPT));

	const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	assert.ok(state.schedules["오픈코드검증"], "예약이 기록되어야 한다");
	assert.strictEqual(state.schedules["오픈코드검증"].skipped, 1);
	const hold = state.holds["oc-1"];
	assert.ok(hold, "보류가 세션 id 로 기록되어야 두 번째 겹이 읽는다");
	assert.strictEqual(hold.exhausted, true);
});

test("보류된 세션의 도구가 거부된다 (tool.execute.before)", async () => {
	const stateFile = path.join(work, "deny.json");
	const plugin = await freshPlugin(stateFile);
	await plugin["chat.message"]({ sessionID: "oc-2" }, message(PROMPT));

	await assert.rejects(
		() => plugin["tool.execute.before"]({ tool: "bash", sessionID: "oc-2", callID: "c1" }),
		(error) => {
			assert.match(error.message, /멈춰 있습니다/);
			assert.match(error.message, /scheduler_delete/);
			return true;
		},
		"opencode 는 거부를 예외로 표현한다",
	);
});

test("보류가 없는 세션의 도구는 그대로 돈다", async () => {
	const stateFile = path.join(work, "allow.json");
	const plugin = await freshPlugin(stateFile);
	await plugin["tool.execute.before"]({ tool: "bash", sessionID: "사람세션", callID: "c1" });
});

test("지시선이 없는 프롬프트는 건드리지 않는다", async () => {
	const stateFile = path.join(work, "untouched.json");
	const plugin = await freshPlugin(stateFile);
	await plugin["chat.message"]({ sessionID: "oc-3" }, message("이슈 42 좀 봐줘"));
	assert.ok(!fs.existsSync(stateFile), "상태 파일조차 만들지 않는다");
	await plugin["tool.execute.before"]({ tool: "bash", sessionID: "oc-3", callID: "c1" });
});

test("예약을 다루는 도구는 보류 중에도 열려 있다", async () => {
	const stateFile = path.join(work, "scheduler.json");
	const plugin = await freshPlugin(stateFile);
	await plugin["chat.message"]({ sessionID: "oc-4" }, message(PROMPT));
	for (const tool of ["scheduler_delete", "scheduler_list"]) {
		await plugin["tool.execute.before"]({ tool, sessionID: "oc-4", callID: "c1" });
	}
});

test("런타임이 달라도 같은 프롬프트가 같은 판정을 받는다", async () => {
	// 이것이 이 시험의 요점이다. opencode 로 옮겨도 하네스가 같아야 한다.
	const gate = require(path.join(ROOT, ".claude", "hooks", "scheduled-task-gate.js"));

	const ocState = path.join(work, "parity-oc.json");
	const plugin = await freshPlugin(ocState);
	await plugin["chat.message"]({ sessionID: "oc-parity" }, message(PROMPT));

	const hookState = path.join(work, "parity-hook.json");
	process.env.NAIA_SCHEDULED_GATE_STATE = hookState;
	gate.onPrompt({ prompt: PROMPT, sessionId: "hook-parity", runtime: "grok", cwd: ROOT });

	const oc = JSON.parse(fs.readFileSync(ocState, "utf8"));
	const hook = JSON.parse(fs.readFileSync(hookState, "utf8"));

	const a = oc.schedules["오픈코드검증"], b = hook.schedules["오픈코드검증"];
	assert.strictEqual(a.fires, b.fires, "회차 수가 같아야 한다");
	assert.strictEqual(a.skipped, b.skipped, "건너뛴 수가 같아야 한다");
	assert.strictEqual(oc.holds["oc-parity"].reason, hook.holds["hook-parity"].reason, "사유가 같아야 한다");
	assert.strictEqual(oc.holds["oc-parity"].exhausted, hook.holds["hook-parity"].exhausted);
	assert.strictEqual(oc.holds["oc-parity"].identity, hook.holds["hook-parity"].identity, "예약 이름이 같아야 한다");
});

test("정책을 복제하지 않고 본체를 불러다 쓴다", () => {
	// 판정 규칙이 두 벌이면 반드시 갈라진다. 플러그인이 스스로 판정하지 않는지 본다.
	const source = fs.readFileSync(path.join(ROOT, ".opencode", "plugins", "scheduled-task-gate.js"), "utf8");
	assert.match(source, /scheduled-task-gate\.js/, "본체를 참조해야 한다");
	for (const forbidden of ["max-fires", "budget-tokens", "#gate"]) {
		assert.ok(!source.includes(`"${forbidden}"`), `플러그인이 ${forbidden} 를 직접 해석하면 안 된다`);
	}
});

let failed = 0;
for (const [name, fn] of cases) {
	try { await fn(); process.stdout.write(`  PASS ${name}\n`); }
	catch (error) { failed += 1; process.stdout.write(`  FAIL ${name}\n    ${error.message}\n`); }
}
process.stdout.write(`${cases.length - failed}/${cases.length} 통과\n`);
process.exit(failed === 0 ? 0 : 1);
