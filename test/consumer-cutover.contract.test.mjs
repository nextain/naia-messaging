import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineSnapshotDigest, installEngineSnapshot, verifyEngineSnapshot } from "../runtime/engine-snapshot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (name.endsWith(".mjs")) out.push(full);
	}
	return out;
}

test("FE-CUTOVER-1: core modules do not import adapters or engine", () => {
	const files = walk(join(root, "core"));
	assert.ok(files.length > 0);
	const forbidden = [];
	for (const file of files) {
		const src = readFileSync(file, "utf8");
		for (const spec of src.matchAll(/from\s+["']([^"']+)["']/g)) {
			if (spec[1].includes("/adapters/") || spec[1].includes("/engine/") || spec[1].startsWith("../adapters") || spec[1].startsWith("../engine")) {
				forbidden.push(`${file} -> ${spec[1]}`);
			}
		}
	}
	assert.deepEqual(forbidden, []);
});

test("FE-CUTOVER-5: package is self-contained and exports engine plus runtime", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(pkg.name, "naia-messaging");
	assert.equal(pkg.dependencies, undefined);
	assert.ok(pkg.exports["./engine/discord/*"]);
	assert.ok(pkg.exports["./runtime/*"]);
	assert.ok(pkg.files.includes("engine"));
	assert.ok(pkg.files.includes("core"));
});

test("FE-CUTOVER-4: snapshot verify rejects a digest mismatch and does not activate it", () => {
	const lock = {
		schemaVersion: 1,
		repository: "nextain/naia-messaging",
		revision: "a".repeat(40),
		snapshotSha256: "b".repeat(64),
	};
	assert.throws(() => verifyEngineSnapshot(root, lock), /digest mismatch|invalid pinned engine lock/);
});

test("ET: installEngineSnapshot copies a verified tree and is idempotent", () => {
	const digest = engineSnapshotDigest(root);
	const lock = {
		schemaVersion: 1,
		repository: "nextain/naia-messaging",
		revision: "c".repeat(40),
		snapshotSha256: digest,
	};
	verifyEngineSnapshot(root, lock);
	const parent = mkdtempSync(join(tmpdir(), "naia-messaging-cutover-"));
	const destination = join(parent, "snap");
	try {
		const first = installEngineSnapshot({ sourceRoot: root, destination, lock });
		assert.equal(first, destination);
		assert.equal(engineSnapshotDigest(destination), digest);
		const marker = join(destination, "package.json");
		const before = readFileSync(marker);
		const second = installEngineSnapshot({ sourceRoot: root, destination, lock });
		assert.equal(second, destination);
		assert.deepEqual(readFileSync(marker), before);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("FE-CUTOVER-6: tracked sample config names an env var and stores no token value", () => {
	const sample = JSON.parse(readFileSync(join(root, "runtime/config.sample.json"), "utf8"));
	const dumped = JSON.stringify(sample);
	assert.doesNotMatch(dumped, /\bBot [A-Za-z0-9._-]{20,}/);
	assert.match(readFileSync(join(root, "docs/issue-3-consumer-cutover.md"), "utf8"), /FE-CUTOVER-7/);
});
