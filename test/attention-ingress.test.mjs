import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueAttentionFromDispatch } from "../engine/discord/attention-ingress.mjs";

test("gateway dispatch wakes the host hook when 3090 is named", async () => {
	const dir = mkdtempSync(join(tmpdir(), "attention-ingress-"));
	const hook = join(dir, "hook.mjs");
	writeFileSync(hook, `export async function handleInboundDiscordMessage(message) {
	  return { consumed: true, started: true, text: message.content };
	}
`);
	chmodSync(hook, 0o600);
	const result = await enqueueAttentionFromDispatch("MESSAGE_CREATE", { content: "3090 ping" }, {
		attention: { enabled: true, hookModule: hook },
	}, dir, {
		scope: { authorId: "operator-id" },
		scopeKey: "scope-key",
		participantProfile: { label: "operator", allowedActions: ["read", "write", "execute"] },
		binding: { operatorActions: true },
	});
	assert.equal(result.consumed, true);
	assert.equal(result.started, true);
	assert.equal(result.text, "3090 ping");
});

test("gateway dispatch rejects malformed hook consumption", async () => {
	const dir = mkdtempSync(join(tmpdir(), "attention-ingress-malformed-"));
	const hook = join(dir, "hook.mjs");
	writeFileSync(hook, `export async function handleInboundDiscordMessage() { return { consumed: "yes" }; }\n`);
	chmodSync(hook, 0o600);
	await assert.rejects(() => enqueueAttentionFromDispatch("MESSAGE_CREATE", { content: "!dev" }, {
		attention: { enabled: true, hookModule: hook },
	}, dir), /consumed must be boolean/);
});

test("gateway dispatch ignores non-message events", async () => {
	const result = await enqueueAttentionFromDispatch("READY", {}, { attention: { enabled: true, hookModule: "/nope" } }, "/tmp");
	assert.equal(result.reason, "ignored");
});
