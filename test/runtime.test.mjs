import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateInstanceConfig } from "../runtime/config-schema.mjs";
import { reconcile } from "../core/monitors/reconcile.mjs";

const sampleConfig = () => ({
	instance: "example",
	transport: "discord",
	tokenEnvVar: "NAIA_MESSAGING_DISCORD_TOKEN",
	participantsFile: "config/participants.local.json",
	contactWindow: { timezone: "UTC", days: ["mon", "tue"], startHour: 9, endHour: 18 },
	bindings: [{ kind: "channel", spaceId: "space-placeholder", channelId: "channel-placeholder", allowedUserIds: ["user-placeholder"] }],
});

test("validateInstanceConfig accepts a well-formed config", () => {
	const config = validateInstanceConfig(sampleConfig());
	assert.equal(config.instance, "example");
	assert.equal(config.bindings.length, 1);
});

test("validateInstanceConfig rejects an inline token", () => {
	const bad = sampleConfig();
	bad.token = "should-not-be-here";
	assert.throws(() => validateInstanceConfig(bad), /inline token/);
});

test("validateInstanceConfig rejects a token env var that looks like a value", () => {
	const bad = sampleConfig();
	bad.tokenEnvVar = "abc-def-not-an-env-name";
	assert.throws(() => validateInstanceConfig(bad), /environment variable/);
});

test("the shipped sample config validates", () => {
	const samplePath = path.resolve(import.meta.dirname, "..", "runtime", "config.sample.json");
	const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
	assert.doesNotThrow(() => validateInstanceConfig(sample));
});

test("reconcile reports divergences and honours a deliberate resolution", () => {
	const result = reconcile({
		trackerItems: [
			{ key: "repo#1", state: "completed" }, // upstream still open -> mismatch
			{ key: "repo#2", state: "completed", closedBy: "luke" }, // deliberately resolved -> ignored
			{ key: "repo#3", state: "dispatched", threadId: "gone" }, // thread missing -> mismatch
		],
		openWorkItems: ["repo#1", "repo#3"],
		liveThreadIds: [],
		sourcePath: "/instance/tracker.json",
	});
	assert.equal(result.ok, false);
	const kinds = result.mismatches.map((m) => `${m.key}:${m.kind}`);
	assert.ok(kinds.includes("repo#1:tracker_closed_upstream_open"));
	assert.ok(kinds.includes("repo#3:thread_missing"));
	assert.ok(!kinds.some((k) => k.startsWith("repo#2")));
	assert.equal(result.sourcePath, "/instance/tracker.json");
});
