/**
 * Public-safety scan.
 *
 * This repository is intended to eventually go public and must hold only
 * generic engine/adapter code. This scan fails the build if a tracked file — or
 * anything reachable in git history — looks like it carries a secret or
 * instance-specific data: a private key, a token, credentials in a URL, an IP
 * address, a platform id (a 17–20 digit snowflake), an email address, or a
 * known instance domain.
 *
 * Ported from naia-comm/scripts/public-safety-scan.mjs and extended for this
 * repository. Findings print WITHOUT the offending value, so the scan output is
 * itself safe to read in a public log.
 *
 * A deliberate carve-out: the bare public API base `https://discord.com/api/...`
 * (with no id path) is legitimate adapter code and is not a secret. Real ids
 * pasted after it are caught by the snowflake rule.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const excluded = new Set([".git", "node_modules", ".runtime", ".secrets", "coverage"]);
const forbiddenNames = new Set(["id_rsa", "id_ed25519"]);

// An instance domain literal, assembled so this scanner does not match itself.
const INSTANCE_DOMAIN = "\\." + "onmam";

const suspicious = [
	/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
	/(?:discord(?:_bot)?_token|github_token|bot_token|password|api[_-]?key)[ \t]*[:=][ \t]*[^\s"']{8,}/i,
	/\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/,
	/https?:\/\/[^\s/@]+:[^\s/@]+@/, // credentials in a URL
	/\b(?:\d{1,3}\.){3}\d{1,3}\b/, // IPv4 literal
	/\b\d{17,20}\b/, // platform snowflake id
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.[A-Za-z]{2,}/, // email address
	new RegExp(INSTANCE_DOMAIN + "\\b"), // known instance domain
];

const findings = [];

function pathParts(file) {
	return file.split(/[\\/]+/).filter(Boolean);
}

function isEnvFilename(name) {
	return name === ".env" || (name.startsWith(".env.") && name !== ".env.example" && name !== ".env.sample");
}

function isForbiddenFilename(file) {
	return pathParts(file).some((part) => isEnvFilename(part) || forbiddenNames.has(part) || part.endsWith(".local"));
}

function isIgnoredLocalPath(file) {
	return pathParts(file).some((part) => excluded.has(part) || isEnvFilename(part));
}

function inspectText(label, text) {
	suspicious.forEach((pattern, index) => {
		if (pattern.test(text)) findings.push(`${label}: pattern ${index + 1}`);
	});
}

function inspectCandidateFile(relativeFile) {
	const rel = relativeFile.split(path.sep).join("/");
	if (isForbiddenFilename(rel)) {
		findings.push(`${rel}: forbidden filename`);
		return;
	}
	const full = path.resolve(root, rel);
	if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
		findings.push(`${rel}: path escapes repository`);
		return;
	}
	let stat;
	try {
		stat = fs.lstatSync(full);
	} catch {
		findings.push(`${rel}: unable to inspect`);
		return;
	}
	if (!stat.isFile()) return;
	let data;
	try {
		data = fs.readFileSync(full);
	} catch {
		findings.push(`${rel}: unable to inspect`);
		return;
	}
	if (data.includes(0)) return; // binary
	inspectText(rel, data.toString("utf8"));
}

function walkPublicTree(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const rel = path.relative(root, full);
		if (isIgnoredLocalPath(rel)) continue;
		if (entry.isDirectory()) walkPublicTree(full);
		else inspectCandidateFile(rel);
	}
}

function scanWorkingTree() {
	if (!fs.existsSync(path.join(root, ".git"))) {
		walkPublicTree(root);
		return;
	}
	let output;
	try {
		output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "buffer" });
	} catch {
		findings.push("working tree: unable to enumerate public files");
		return;
	}
	for (const file of output.toString("utf8").split("\0").filter(Boolean)) inspectCandidateFile(file);
}

function scanReachableHistory() {
	if (!fs.existsSync(path.join(root, ".git"))) return;
	let revisions = [];
	try {
		revisions = execFileSync("git", ["rev-list", "--all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch {
		return; // no history yet
	}
	for (const revision of revisions) {
		let files = [];
		try {
			files = execFileSync("git", ["ls-tree", "-r", "--name-only", revision], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
		} catch {
			continue;
		}
		for (const file of files) {
			if (isForbiddenFilename(file)) findings.push(`history ${revision.slice(0, 12)} ${file}: forbidden filename`);
			let data;
			try {
				data = execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, encoding: null, maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
			} catch {
				continue;
			}
			if (!data.includes(0)) inspectText(`history ${revision.slice(0, 12)} ${file}`, data.toString("utf8"));
		}
	}
}

scanWorkingTree();
scanReachableHistory();

if (findings.length) {
	console.error("public-safety scan failed (values intentionally omitted):");
	for (const item of findings) console.error(`- ${item}`);
	process.exit(1);
}
console.log("public-safety scan passed");
