import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSummary, boundedSafeExcerpt, safeIdentifier } from "../core/redact.mjs";
import { formatIdentity, validateParticipantRegistry } from "../core/identity.mjs";
import { validateBindings, authorize, scopeKey } from "../core/binding.mjs";
import { whoseTurn, classifyAgentMessage } from "../core/verdict.mjs";
import { buildConfirmationRequest, buildApprovalRequest } from "../core/confirmation.mjs";
import { normaliseContactWindow, withinContactWindow, shouldContact } from "../core/contact-window.mjs";
import { splitContent, deliver, chunkNonce } from "../core/delivery.mjs";

test("redact removes secrets and local paths", () => {
	const out = sanitizeSummary("token=abcdef1234567890 in /home/luke/secret");
	assert.match(out, /\[REDACTED\]/);
	assert.match(out, /\[LOCAL_PATH\]/);
	assert.ok(!out.includes("/home/luke"));
});

test("boundedSafeExcerpt truncates and flags", () => {
	assert.equal(boundedSafeExcerpt(""), null);
	const long = boundedSafeExcerpt("x".repeat(1000));
	assert.equal(long.truncated, true);
});

test("safeIdentifier rejects unsafe ids", () => {
	assert.equal(safeIdentifier("job-42"), "job-42");
	assert.throws(() => safeIdentifier("has space"));
});

test("formatIdentity emits [alias/project] and rejects a raw id", () => {
	assert.equal(formatIdentity({ alias: "lead", project: "team-hub" }), "[lead/team-hub]");
	assert.throws(() => formatIdentity({ alias: "L U K E", project: "x" }));
});

test("participant registry enforces alias uniqueness and one workspace", () => {
	const ok = validateParticipantRegistry({ participants: [
		{ platformUserId: "id-a", alias: "luke", project: "p1", workspace: "w1" },
		{ platformUserId: "id-b", alias: "luke", project: "p2", workspace: "w2" },
	] });
	assert.equal(ok.length, 2);
	assert.throws(() => validateParticipantRegistry({ participants: [
		{ platformUserId: "id-a", alias: "luke", project: "p1", workspace: "w1" },
		{ platformUserId: "id-c", alias: "luke", project: "p1", workspace: "w2" },
	] }), /not unique/);
	assert.throws(() => validateParticipantRegistry({ participants: [
		{ platformUserId: "id-a", alias: "luke", project: "p1", workspace: "w1" },
		{ platformUserId: "id-a", alias: "dh", project: "p2", workspace: "w2" },
	] }), /more than one/);
});

test("binding authorization: mention gates a shared space", () => {
	const bindings = validateBindings([
		{ kind: "channel", spaceId: "g1", channelId: "c1", allowedUserIds: ["u1"] },
	]);
	const scope = { kind: "channel", spaceId: "g1", channelId: "c1", authorId: "u1" };
	assert.equal(authorize({ scope, bindings, isMentioned: false, isAutomated: false }).reasonCode, "mention_required");
	assert.equal(authorize({ scope, bindings, isMentioned: true, isAutomated: false }).allowed, true);
	assert.equal(authorize({ scope, bindings, isMentioned: true, isAutomated: true }).allowed, false);
});

test("binding: unknown user and missing binding are refused", () => {
	const bindings = validateBindings([{ kind: "channel", spaceId: "g1", channelId: "c1", allowedUserIds: ["u1"] }]);
	// A message in a scope that no binding matches at all.
	assert.equal(authorize({ scope: { kind: "channel", spaceId: "g9", channelId: "c9", authorId: "u1" }, bindings, isMentioned: true, isAutomated: false }).reasonCode, "binding_missing");
	// A message in a matched scope but from an unlisted user.
	assert.equal(authorize({ scope: { kind: "channel", spaceId: "g1", channelId: "c1", authorId: "u9" }, bindings, isMentioned: true, isAutomated: false }).reasonCode, "user_not_allowed");
});

test("scopeKey is stable and non-reversible-length", () => {
	const a = scopeKey({ kind: "thread", spaceId: "g", channelId: "c", threadId: "t" });
	const b = scopeKey({ kind: "thread", spaceId: "g", channelId: "c", threadId: "t" });
	assert.equal(a, b);
	assert.equal(a.length, 24);
});

test("workItem shape is validated", () => {
	assert.throws(() => validateBindings([{ kind: "dm", userId: "u1", allowedUserIds: ["u1"], workItem: "no-number" }]));
	assert.doesNotThrow(() => validateBindings([{ kind: "dm", userId: "u1", allowedUserIds: ["u1"], workItem: "repo#12" }]));
});

test("whoseTurn: bare ack does not count as a response", () => {
	const now = () => Date.parse("2026-09-10T10:00:00.000Z");
	const msgs = [
		{ authorIsAgent: true, text: "[message received]" },
		{ authorIsAgent: false, text: "please deploy", timestamp: "2026-09-10T09:30:00.000Z", author: "luke" },
	];
	const v = whoseTurn(msgs, now);
	assert.equal(v.whoseTurn, "agent");
	assert.equal(v.waitingMinutes, 30);
});

test("whoseTurn: a real reply flips to human", () => {
	const msgs = [
		{ authorIsAgent: true, text: "done, deployed at abc123" },
		{ authorIsAgent: false, text: "please deploy" },
	];
	assert.equal(whoseTurn(msgs).whoseTurn, "human");
});

test("classifyAgentMessage separates receipt from response", () => {
	assert.equal(classifyAgentMessage("[message received]"), "start_receipt");
	assert.equal(classifyAgentMessage("here is the result"), "response");
	assert.equal(classifyAgentMessage("  "), "empty");
});

test("confirmation request requires the four fields", () => {
	assert.throws(() => buildConfirmationRequest({ who: "luke", what: "x", whereExactly: "y" }), /whereToReportBack/);
	const req = buildConfirmationRequest({ who: "luke", what: "check deploy", whereExactly: "prod", whereToReportBack: "this thread" });
	assert.deepEqual(Object.keys(req).sort(), ["what", "whereExactly", "whereToReportBack", "who"]);
});

test("approval request requires decision and default", () => {
	assert.throws(() => buildApprovalRequest({ oneSentenceDecision: "ship it?" }), /defaultIfNoAnswer/);
});

test("contact window gates nudges but never malfunctions", () => {
	const window = normaliseContactWindow({ timezone: "UTC", days: ["mon", "tue", "wed", "thu", "fri"], startHour: 9, endHour: 18 });
	const monMorning = new Date("2026-09-07T10:00:00Z"); // Monday
	const satNight = new Date("2026-09-12T23:00:00Z"); // Saturday
	assert.equal(withinContactWindow(window, monMorning), true);
	assert.equal(withinContactWindow(window, satNight), false);
	assert.equal(shouldContact({ kind: "thread_nudge", window, at: satNight }).send, false);
	assert.equal(shouldContact({ kind: "malfunction", window, at: satNight }).send, true);
	assert.equal(shouldContact({ kind: "thread_nudge", window, at: satNight, urgent: true }).send, true);
});

test("contact window enforces a re-ask budget", () => {
	const window = normaliseContactWindow({ timezone: "UTC", days: ["mon"], startHour: 0, endHour: 24 });
	const at = new Date("2026-09-07T10:00:00Z");
	assert.equal(shouldContact({ kind: "thread_nudge", window, at, timesAsked: 3, maxReAsks: 3 }).send, false);
	assert.equal(shouldContact({ kind: "thread_nudge", window, at, timesAsked: 1, maxReAsks: 3 }).send, true);
});

test("delivery splits long content and drives idempotent attempts", async () => {
	const chunks = splitContent("a".repeat(2000), { maxChars: 900, maxBytes: 1500 });
	assert.ok(chunks.length >= 2);
	assert.notEqual(chunkNonce("n".repeat(24), 0), chunkNonce("n".repeat(24), 1));
	const seen = [];
	const res = await deliver({ content: "hello", postOnce: async (chunk, n) => { seen.push(n); return { state: "confirmed", messageId: "1" }; } });
	assert.equal(res.state, "confirmed");
	assert.equal(seen.length, 1);
});

test("delivery stops on a failed receipt", async () => {
	const res = await deliver({ content: "a".repeat(2000), postOnce: async () => ({ state: "failed", reasonCode: "authorization" }) });
	assert.equal(res.state, "failed");
	assert.equal(res.receipts.length, 1);
});
