import { closeSync, constants as fsConstants, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";
import { CREDENTIAL_PROFILES, validateCredentialProfiles } from "./credential-profiles.mjs";
import { GROK_AVAILABLE_BINDINGS, grokDiscordCost } from "./grok-cost-profile.mjs";

const SAFE_ENV_KEYS = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP"]);
const API_KEY_BY_BACKEND = { codex: "CODEX_API_KEY", claude: "ANTHROPIC_API_KEY", grok: "XAI_API_KEY" };
const DISPOSABLE_CREDENTIAL_DIRECTORIES = new Set(["logs", "cache", "surface_data"]);

export function resolveExecutionCwd(cwd) {
	if (typeof cwd !== "string" || cwd.length === 0) throw new Error("execution cwd is required");
	if (!isAbsolute(cwd)) throw new Error("execution cwd must be absolute");
	const resolvedCwd = resolve(cwd);
	const stat = lstatSync(resolvedCwd);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("execution cwd must be a real directory");
	return resolvedCwd;
}

function assertRealFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
}

function privateDirectory(path) {
	const resolvedPath = resolve(path);
	const root = parse(resolvedPath).root;
	let cursor = root;
	for (const part of resolvedPath.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
		cursor = resolve(cursor, part);
		if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`private path contains a symbolic link: ${cursor}`);
	}
	mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
	const stat = lstatSync(resolvedPath);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`private path must be a real directory: ${resolvedPath}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`private path owner mismatch: ${resolvedPath}`);
	chmodSync(resolvedPath, 0o700);
	protectOwnerOnly(resolvedPath, "directory", "private directory");
}

function copyCredential(source, target, label, { ownerOnly = true } = {}) {
	if (!existsSync(source)) return false;
	assertRealFile(source, label);
	if (ownerOnly) assertOwnerOnly(source, "file", label);
	else if ((lstatSync(source).mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
	privateDirectory(dirname(target));
	const sourceFd = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	let targetFd;
	try {
		targetFd = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			let offset = 0;
			while (offset < bytesRead) offset += writeSync(targetFd, buffer, offset, bytesRead - offset);
		}
	} finally {
		closeSync(sourceFd);
		if (targetFd !== undefined) closeSync(targetFd);
	}
	chmodSync(target, 0o600);
	protectOwnerOnly(target, "file", label);
	return true;
}

function assertSafeCredentialTree(path, label) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(path)) {
		if (!DISPOSABLE_CREDENTIAL_DIRECTORIES.has(entry)) assertSafeCredentialTree(join(path, entry), label);
	}
}

function protectCopiedCredentialTree(path) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) throw new Error("copied credential tree contains a symbolic link");
	if (stat.isDirectory()) {
		chmodSync(path, 0o700);
		for (const entry of readdirSync(path)) protectCopiedCredentialTree(join(path, entry));
	} else if (stat.isFile()) {
		chmodSync(path, 0o600);
	}
}

// OpenCode resolves the user config, the project config, and the selected
// agent independently. A top-level permission overlay therefore does not
// contain a hostile `agent.build` rule from the user's provider config. Keep
// only provider/model resolution fields in the copied provider file and make
// the selected agent deny by default. Unknown and custom tools consequently
// stay denied even when a host config contains task, MCP, or plugin entries.
const OPENCODE_READ_ONLY_PERMISSION = Object.freeze({ "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" });
const OPENCODE_PROVIDER_CONFIG_KEYS = new Set(["$schema", "provider", "model", "small_model"]);
const OPENCODE_CONFIG_MAX_BYTES = 4 * 1024 * 1024;

function invalidOpenCodeProviderConfig() {
	return new Error("OpenCode provider configuration is invalid");
}

function stripJsoncComments(source) {
	let output = "";
	let inString = false;
	let escaped = false;
	let comment = null;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		const next = source[index + 1];
		if (comment === "line") {
			if (character === "\n" || character === "\r") {
				output += character;
				comment = null;
			} else output += " ";
			continue;
		}
		if (comment === "block") {
			if (character === "*" && next === "/") {
				output += "  ";
				index += 1;
				comment = null;
			} else if (character === "\n" || character === "\r") output += character;
			else output += " ";
			continue;
		}
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
		} else if (character === "/" && next === "/") {
			output += "  ";
			index += 1;
			comment = "line";
		} else if (character === "/" && next === "*") {
			output += "  ";
			index += 1;
			comment = "block";
		} else output += character;
	}
	if (comment === "block" || inString) throw invalidOpenCodeProviderConfig();
	return output;
}

function removeJsoncTrailingCommas(source) {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			continue;
		}
		if (character === ",") {
			let next = index + 1;
			while (next < source.length && /\s/.test(source[next])) next += 1;
			if (source[next] === "}" || source[next] === "]") continue;
		}
		output += character;
	}
	if (inString) throw invalidOpenCodeProviderConfig();
	return output;
}

function parseOpenCodeJsonc(source) {
	if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > OPENCODE_CONFIG_MAX_BYTES) throw invalidOpenCodeProviderConfig();
	let parsed;
	try { parsed = JSON.parse(removeJsoncTrailingCommas(stripJsoncComments(source))); }
	catch { throw invalidOpenCodeProviderConfig(); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidOpenCodeProviderConfig();
	return parsed;
}

function sanitizeOpenCodeProviderConfig(source) {
	const parsed = parseOpenCodeJsonc(source);
	const sanitized = {};
	for (const key of OPENCODE_PROVIDER_CONFIG_KEYS) {
		if (!Object.hasOwn(parsed, key)) continue;
		if (key === "$schema" || key === "model" || key === "small_model") {
			if (typeof parsed[key] !== "string" || parsed[key].length === 0) throw invalidOpenCodeProviderConfig();
			sanitized[key] = parsed[key];
		} else {
			if (!parsed[key] || typeof parsed[key] !== "object" || Array.isArray(parsed[key])) throw invalidOpenCodeProviderConfig();
			sanitized[key] = parsed[key];
		}
	}
	return JSON.stringify(sanitized);
}

function writeOwnerOnlyFile(target, content, label) {
	privateDirectory(dirname(target));
	const fd = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
	try {
		const buffer = Buffer.from(content, "utf8");
		let offset = 0;
		while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
	} finally { closeSync(fd); }
	chmodSync(target, 0o600);
	protectOwnerOnly(target, "file", label);
	return target;
}

function writeOpencodeConfig(childHome, { readOnly, model }) {
	const target = join(childHome, "opencode-read-only.json");
	const overlay = { plugin: [] };
	if (readOnly) {
		overlay.permission = { ...OPENCODE_READ_ONLY_PERMISSION };
		overlay.agent = { build: { mode: "primary", permission: { ...OPENCODE_READ_ONLY_PERMISSION } } };
	}
	if (model !== null) {
		if (typeof model !== "string" || !model.trim()) throw new Error("model must be a non-empty string when pinned");
		overlay.model = model;
		overlay.small_model = model;
		overlay.default_agent = "build";
		overlay.agent = { build: { ...overlay.agent?.build, mode: "primary", model } };
	}
	return writeOwnerOnlyFile(target, JSON.stringify(overlay), "OpenCode overlay configuration");
}

function copyOpenCodeProviderConfig(source, target, { readOnly, model }) {
	if (!existsSync(source)) return false;
	if (!readOnly && model === null) return copyCredential(source, target, "OpenCode provider configuration", { ownerOnly: false });
	assertRealFile(source, "OpenCode provider configuration");
	if ((lstatSync(source).mode & 0o022) !== 0) throw new Error("OpenCode provider configuration must not be group- or world-writable");
	const sanitized = sanitizeOpenCodeProviderConfig(readFileSync(source, "utf8"));
	if (model !== null) {
		const parsed = JSON.parse(sanitized);
		parsed.model = model;
		parsed.small_model = model;
		return Boolean(writeOwnerOnlyFile(target, JSON.stringify(parsed), "OpenCode sanitized provider configuration"));
	}
	return Boolean(writeOwnerOnlyFile(target, sanitized, "OpenCode sanitized provider configuration"));
}

export function defaultRuntimeRoot(parentEnv, systemTempDirectory = tmpdir()) {
	const base = parentEnv.XDG_RUNTIME_DIR && resolve(parentEnv.XDG_RUNTIME_DIR) === parentEnv.XDG_RUNTIME_DIR
		? parentEnv.XDG_RUNTIME_DIR
		: join(realpathSync(systemTempDirectory), `naia-adk-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
	return join(base, "messenger-sessions");
}

export function prepareChildEnvironment({ backendId, attemptId, runtimeRoot, parentEnv = process.env, authRoot = homedir(), workspacePath = null, prepareAuthentication = true, credentialProfiles = [], costProfile = null, readOnly = true, model = null }) {
	const selectedCredentialProfiles = validateCredentialProfiles(credentialProfiles, "child credential profiles");
	const childHome = resolve(runtimeRoot ?? defaultRuntimeRoot(parentEnv), "children", attemptId);
	privateDirectory(childHome);
	try {
		const env = {};
		for (const key of SAFE_ENV_KEYS) if (parentEnv[key]) env[key] = parentEnv[key];
		if (env.PATH) {
			const workspace = workspacePath ? resolve(workspacePath) : null;
			env.PATH = env.PATH.split(delimiter).filter((entry) => {
				if (!entry || !isAbsolute(entry) || entry.split(/[\\/]+/).includes("node_modules")) return false;
				const resolvedEntry = resolve(entry);
				if (!workspace) return true;
				const child = relative(workspace, resolvedEntry);
				return child !== "" && (child.startsWith("..") || isAbsolute(child));
			}).join(delimiter);
		}
		env.HOME = childHome;
		env.NO_COLOR = "1";
		for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "TMPDIR"]) {
			env[key] = join(childHome, key.toLowerCase());
			privateDirectory(env[key]);
		}
		const apiKeyName = API_KEY_BY_BACKEND[backendId];
		if (prepareAuthentication && apiKeyName && parentEnv[apiKeyName]) env[apiKeyName] = parentEnv[apiKeyName];
		let authenticationPrepared = Boolean(prepareAuthentication && apiKeyName && parentEnv[apiKeyName]);
		if (backendId === "codex") {
			const codexHome = join(childHome, ".codex");
			privateDirectory(codexHome);
			env.CODEX_HOME = codexHome;
			if (prepareAuthentication) authenticationPrepared ||= copyCredential(join(authRoot, ".codex", "auth.json"), join(codexHome, "auth.json"), "Codex authentication");
		} else if (backendId === "claude") {
			privateDirectory(join(childHome, ".claude"));
			env.CLAUDE_CODE_RETRY_WATCHDOG = "1";
			env.CLAUDE_CODE_MAX_RETRIES = "15";
			if (prepareAuthentication) authenticationPrepared ||= copyCredential(join(authRoot, ".claude", ".credentials.json"), join(childHome, ".claude", ".credentials.json"), "Claude authentication");
		} else if (backendId === "opencode") {
			// opencode run 에는 권한 플래그가 없다(--auto 는 넓히기만 한다). 실제
			// 거부는 설정으로만 만들 수 있고, 두 가지를 함께 줘야 한다: 자식 홈의
			// 소유자 전용 deny 오버레이와 프로젝트 설정 비활성화. 오버레이만 주면
			// 작업 대상 워크스페이스의 opencode.json 이 이를 다시 열어 버린다.
			const pinned = model !== null;
			if (readOnly || pinned) {
				env.OPENCODE_CONFIG = writeOpencodeConfig(childHome, { readOnly, model });
				env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
			}
			if (pinned) {
				env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
				env.OPENCODE_DISABLE_AUTOUPDATE = "1";
				env.OPENCODE_DISABLE_MODELS_FETCH = "1";
			}
			if (prepareAuthentication) {
				const configCopied = copyOpenCodeProviderConfig(
					join(authRoot, ".config", "opencode", "opencode.jsonc"),
					join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"),
					{ readOnly, model },
				);
				const authCopied = copyCredential(
					join(authRoot, ".local", "share", "opencode", "auth.json"),
					join(env.XDG_DATA_HOME, "opencode", "auth.json"),
					"OpenCode authentication",
				);
				authenticationPrepared = configCopied && authCopied;
			}
		} else if (backendId === "grok") {
			const grokHome = join(childHome, ".grok");
			privateDirectory(grokHome);
			env.GROK_HOME = grokHome;
			const grokCost = grokDiscordCost(costProfile ?? "balanced");
			env.CODEX_DEVELOPMENT_PROFILE = grokCost.developmentProfile;
			env.CODEX_AVAILABLE_BINDINGS = GROK_AVAILABLE_BINDINGS;
			if (prepareAuthentication) authenticationPrepared ||= copyCredential(join(authRoot, ".grok", "auth.json"), join(grokHome, "auth.json"), "Grok authentication");
		} else {
			throw new Error(`unsupported backend environment: ${backendId}`);
		}
		for (const profileId of selectedCredentialProfiles) {
			const profile = CREDENTIAL_PROFILES[profileId];
			const source = join(authRoot, ...profile.source);
			const targetBase = profile.target.base === "xdgConfig"
				? env.XDG_CONFIG_HOME
				: profile.target.base === "xdgData"
					? env.XDG_DATA_HOME
					: childHome;
			const target = join(targetBase, ...profile.target.parts);
			if (profile.kind === "file") {
				const copied = copyCredential(source, target, profile.label);
				if (!copied) throw new Error(`${profileId} authentication is unavailable`);
			} else {
				if (!existsSync(source)) throw new Error(`${profileId} authentication is unavailable`);
				const stat = lstatSync(source);
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${profileId} authentication directory is unsafe`);
				assertSafeCredentialTree(source, profile.label);
				privateDirectory(dirname(target));
				// Diagnostic logs and caches are disposable and can grow to gigabytes
				// during repeated jobs. Copy only configuration and credential material.
				cpSync(source, target, {
					recursive: true,
					dereference: false,
					errorOnExist: true,
					force: false,
					filter: (entry) => !new Set(profile.exclude ?? []).has(entry.split(/[\\/]/).pop()),
				});
				protectCopiedCredentialTree(target);
			}
			for (const [key, value] of Object.entries(profile.env ?? {})) env[key] = value;
			for (const [key, value] of Object.entries(profile.envPath ?? {})) if (value === "target") env[key] = target;
		}
		return { childHome, env, authenticationPrepared };
	} catch (error) {
		if (existsSync(childHome)) cleanupChildEnvironment(childHome);
		throw error;
	}
}

export function cleanupChildEnvironment(childHome) {
	const stat = lstatSync(childHome);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("refusing to clean an unsafe child environment");
	rmSync(childHome, { recursive: true, force: false });
}
