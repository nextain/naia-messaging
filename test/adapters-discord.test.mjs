import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiscordScope, isBotMentioned, authorizeDiscordMessage } from "../adapters/discord/scope.mjs";
import { describeDiscordAttachments, attachmentSummaryText, safeAttachmentName } from "../adapters/discord/attachments.mjs";
import { postDiscordMessageOnce, deliverToDiscord } from "../adapters/discord/delivery.mjs";
import { validateBindings } from "../core/binding.mjs";

// Synthetic snowflakes built at runtime so no literal id appears in source.
const gid = "8".repeat(18);
const cid = "7".repeat(18);
const tid = "6".repeat(18);
const uid = "5".repeat(18);
const bot = "4".repeat(18);

test("classifyDiscordScope: dm, channel, thread", () => {
	assert.equal(classifyDiscordScope({ channel_id: cid, author: { id: uid } }).kind, "dm");
	assert.equal(classifyDiscordScope({ channel_id: cid, guild_id: gid, author: { id: uid } }).kind, "channel");
	const parents = new Map([[tid, { parentChannelId: cid }]]);
	const scope = classifyDiscordScope({ channel_id: tid, guild_id: gid, author: { id: uid } }, parents);
	assert.equal(scope.kind, "thread");
	assert.equal(scope.threadId, tid);
	assert.equal(scope.channelId, cid);
});

test("isBotMentioned reads the mentions array", () => {
	assert.equal(isBotMentioned({ mentions: [{ id: bot }] }, bot), true);
	assert.equal(isBotMentioned({ mentions: [{ id: uid }] }, bot), false);
});

test("authorizeDiscordMessage refuses a bot sender and honours mention gate", () => {
	const bindings = validateBindings([{ kind: "channel", spaceId: gid, channelId: cid, allowedUserIds: [uid] }]);
	assert.equal(authorizeDiscordMessage({ message: { author: { id: bot, bot: true }, channel_id: cid, guild_id: gid }, bindings, botUserId: bot }).reasonCode, "automated_sender");
	const msg = { author: { id: uid }, channel_id: cid, guild_id: gid, mentions: [{ id: bot }] };
	assert.equal(authorizeDiscordMessage({ message: msg, bindings, botUserId: bot }).allowed, true);
});

test("describeDiscordAttachments keeps only fetchable items", () => {
	const message = { id: "9".repeat(18), attachments: [
		{ id: "3".repeat(18), filename: "report.pdf", size: 100, content_type: "application/pdf" },
		{ id: "not-a-snowflake", filename: "bad" },
	] };
	const { attachments, omitted } = describeDiscordAttachments(message);
	assert.equal(attachments.length, 1);
	assert.equal(omitted, 1);
	assert.match(attachmentSummaryText(message), /report\.pdf/);
});

test("safeAttachmentName strips path traversal", () => {
	assert.equal(safeAttachmentName("../../etc/passwd"), "passwd");
	assert.equal(safeAttachmentName(""), null);
});

test("postDiscordMessageOnce maps responses to core receipts", async () => {
	const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "1".repeat(18), channel_id: cid, author: { id: bot }, nonce: "abc" }) });
	const ok = await postDiscordMessageOnce({ token: "x".repeat(32), channelId: cid, content: "hi", nonce: "abc", botUserId: bot, fetchImpl: okFetch });
	assert.equal(ok.state, "confirmed");

	const unauthorized = async () => ({ ok: false, status: 401, json: async () => ({}) });
	const failed = await postDiscordMessageOnce({ token: "x".repeat(32), channelId: cid, content: "hi", nonce: "abc", fetchImpl: unauthorized });
	assert.equal(failed.state, "failed");
	assert.equal(failed.reasonCode, "authorization");

	const boom = async () => { throw new Error("network"); };
	const unknown = await postDiscordMessageOnce({ token: "x".repeat(32), channelId: cid, content: "hi", nonce: "abc", fetchImpl: boom });
	assert.equal(unknown.state, "unknown");
});

test("deliverToDiscord drives core delivery", async () => {
	let calls = 0;
	const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "1".repeat(18), channel_id: cid, author: { id: bot } }) });
	const res = await deliverToDiscord({ token: "x".repeat(32), channelId: cid, content: "short reply", botUserId: bot, fetchImpl: (...a) => { calls += 1; return okFetch(...a); } });
	assert.equal(res.state, "confirmed");
	assert.equal(calls, 1);
});
