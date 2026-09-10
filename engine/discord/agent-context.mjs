import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

export const AGENT_CONTEXT_LIMITS = Object.freeze({
	maxContextFiles: 16,
	maxFileBytes: 256 * 1024,
	maxTotalBytes: 1024 * 1024,
});

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CONTEXT_SCHEMA = "naia-agent-context-v1";

export class AgentContextChangedError extends Error {
	constructor() {
		super("agent context changed; restart the Discord service");
		this.name = "AgentContextChangedError";
		this.code = "context_changed_restart_required";
	}
}

function configuredRelativePath(value, label) {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || isAbsolute(value) || value.includes("\\") || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} must be a bounded POSIX relative path`);
	}
	const parts = value.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${label} must not contain empty or traversal segments`);
	return parts.join("/");
}

function insideWorkspace(workspaceRoot, candidate) {
	const child = relative(workspaceRoot, candidate);
	return child !== "" && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child);
}

function resolveContextFile(workspaceRoot, relativePath) {
	let cursor = workspaceRoot;
	for (const part of relativePath.split("/")) {
		cursor = resolve(cursor, part);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error("agent context paths must not contain symbolic links");
	}
	const absolutePath = realpathSync(cursor);
	if (!insideWorkspace(workspaceRoot, absolutePath)) throw new Error("agent context path escaped the workspace");
	const stat = lstatSync(absolutePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("agent context path must be a real file");
	return absolutePath;
}

export function resolveAgentContextWorkspace(config) {
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("agent context workspace config is required");
	if (typeof config.workspace !== "string" || config.workspace.length === 0) throw new Error("agent context workspace is required");
	const configuredWorkspace = resolve(config.workspace);
	const filesystemRoot = parse(configuredWorkspace).root;
	let workspaceCursor = filesystemRoot;
	for (const part of configuredWorkspace.slice(filesystemRoot.length).split(/[\\/]+/).filter(Boolean)) {
		workspaceCursor = resolve(workspaceCursor, part);
		if (lstatSync(workspaceCursor).isSymbolicLink()) throw new Error("agent context workspace must not contain symbolic links");
	}
	const workspaceRoot = realpathSync(configuredWorkspace);
	const rootStat = lstatSync(workspaceRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("agent context workspace must be a real directory");
	const entrypoint = configuredRelativePath(config.entrypoint, "entrypoint");
	if (config.contextFiles !== undefined && !Array.isArray(config.contextFiles)) throw new Error("contextFiles must be an array");
	const contextFiles = (config.contextFiles ?? []).map((value) => configuredRelativePath(value, "context file")).sort();
	if (contextFiles.length + 1 > AGENT_CONTEXT_LIMITS.maxContextFiles) throw new Error("agent context file count exceeds the limit");
	const relativePaths = [entrypoint, ...contextFiles];
	if (new Set(relativePaths).size !== relativePaths.length) throw new Error("agent context files must be unique");
	const seen = new Set();
	const files = relativePaths.map((relativePath, index) => {
		const absolutePath = resolveContextFile(workspaceRoot, relativePath);
		if (seen.has(absolutePath)) throw new Error("agent context files must resolve uniquely");
		seen.add(absolutePath);
		return Object.freeze({ kind: index === 0 ? "entrypoint" : "context", relativePath, absolutePath });
	});
	return Object.freeze({ workspaceRoot, files: Object.freeze(files) });
}

function configuredAgentId(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) throw new Error("agentId must be a safe identifier");
	return value;
}

function hashSnapshotEntries(entries, agentId) {
	const hash = createHash("sha256");
	hash.update(`${CONTEXT_SCHEMA}\0${agentId}\0`, "utf8");
	for (const entry of entries) {
		const pathBytes = Buffer.from(`${entry.kind}\0${entry.relativePath}`, "utf8");
		const lengths = Buffer.allocUnsafe(12);
		lengths.writeUInt32BE(pathBytes.length, 0);
		lengths.writeBigUInt64BE(BigInt(entry.bytes.length), 4);
		hash.update(lengths);
		hash.update(pathBytes);
		hash.update(entry.bytes);
	}
	return hash.digest("hex");
}

function sameFile(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function openedFilePath(fd, configuredPath) {
	const descriptorPath = `/proc/self/fd/${fd}`;
	return process.platform !== "win32" && existsSync(descriptorPath) ? realpathSync(descriptorPath) : realpathSync(configuredPath);
}

function assertOpenedFileIdentity({ fd, configuredPath, workspaceRoot, openedStat }) {
	const actualPath = openedFilePath(fd, configuredPath);
	if (!insideWorkspace(workspaceRoot, actualPath)) throw new Error("opened agent context file escaped the workspace");
	const currentPath = realpathSync(configuredPath);
	if (currentPath !== actualPath) throw new Error("agent context path changed while opening");
	const currentStat = lstatSync(currentPath);
	if (currentStat.isSymbolicLink() || !currentStat.isFile() || !sameFile(openedStat, currentStat)) throw new Error("agent context file identity changed while opening");
	return actualPath;
}

function openAnchoredContextFile(workspaceRoot, relativePath) {
	const procFdRoot = "/proc/self/fd";
	if (process.platform === "win32" || !existsSync(procFdRoot) || fsConstants.O_DIRECTORY === undefined) return null;
	const anchors = [];
	try {
		let directoryFd = openSync(workspaceRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0));
		anchors.push(directoryFd);
		if (realpathSync(`${procFdRoot}/${directoryFd}`) !== workspaceRoot) throw new Error("agent context workspace identity changed while opening");
		const parts = relativePath.split("/");
		for (const part of parts.slice(0, -1)) {
			directoryFd = openSync(`${procFdRoot}/${directoryFd}/${part}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0));
			anchors.push(directoryFd);
			if (!insideWorkspace(workspaceRoot, realpathSync(`${procFdRoot}/${directoryFd}`))) throw new Error("agent context directory escaped the workspace");
		}
		const fd = openSync(`${procFdRoot}/${directoryFd}/${parts.at(-1)}`, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		return { fd, closeAnchors: () => { while (anchors.length) closeSync(anchors.pop()); } };
	} catch (error) {
		while (anchors.length) closeSync(anchors.pop());
		throw error;
	}
}

function readBoundedContextFile(path, relativePath, workspaceRoot) {
	const anchored = openAnchoredContextFile(workspaceRoot, relativePath);
	const fd = anchored?.fd ?? openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("agent context path must be a real file");
		const actualPath = openedFilePath(fd, path);
		if (!insideWorkspace(workspaceRoot, actualPath)) throw new Error("opened agent context file escaped the workspace");
		if (!anchored) assertOpenedFileIdentity({ fd, configuredPath: path, workspaceRoot, openedStat: stat });
		if (stat.size > AGENT_CONTEXT_LIMITS.maxFileBytes) throw new Error("agent context file exceeds the size limit");
		const bytes = readFileSync(fd);
		if (bytes.length > AGENT_CONTEXT_LIMITS.maxFileBytes) throw new Error("agent context file exceeds the size limit");
		if (openedFilePath(fd, path) !== actualPath) throw new Error("opened agent context file changed while reading");
		if (!anchored) assertOpenedFileIdentity({ fd, configuredPath: path, workspaceRoot, openedStat: stat });
		return bytes;
	} finally {
		closeSync(fd);
		anchored?.closeAnchors();
	}
}

function renderStablePrefix(entries, contextHash, agentId) {
	const lines = [
		"Naia deterministic project context (authoritative project files).",
		`Configured-Agent: ${agentId}`,
		`Context-SHA256: ${contextHash}`,
		"Use this stable context before participant data or untrusted conversation history.",
	];
	for (const entry of entries) {
		lines.push("", `--- ${entry.kind}: ${entry.relativePath} (${entry.bytes.length} bytes) ---`, entry.text);
	}
	lines.push("", "--- end deterministic project context ---");
	return lines.join("\n");
}

function snapshotResolvedWorkspace(resolvedWorkspace, agentId) {
	let totalBytes = 0;
	const entries = resolvedWorkspace.files.map((file) => {
		const bytes = readBoundedContextFile(file.absolutePath, file.relativePath, resolvedWorkspace.workspaceRoot);
		totalBytes += bytes.length;
		if (totalBytes > AGENT_CONTEXT_LIMITS.maxTotalBytes) throw new Error("agent context total size exceeds the limit");
		let text;
		try { text = UTF8.decode(bytes); }
		catch { throw new Error("agent context files must be valid UTF-8"); }
		return { ...file, bytes, text, sha256: createHash("sha256").update(bytes).digest("hex") };
	});
	const contextHash = hashSnapshotEntries(entries, agentId);
	const manifestFiles = entries.map((entry) => Object.freeze({
		kind: entry.kind,
		path: entry.relativePath,
		bytes: entry.bytes.length,
		sha256: entry.sha256,
	}));
	return Object.freeze({
		schemaVersion: 1,
		workspaceRoot: resolvedWorkspace.workspaceRoot,
		agentId,
		contextHash,
		totalBytes,
		manifest: Object.freeze({ schema: CONTEXT_SCHEMA, files: Object.freeze(manifestFiles) }),
		prefix: renderStablePrefix(entries, contextHash, agentId),
	});
}

export function buildAgentContextSnapshot(config) {
	return snapshotResolvedWorkspace(resolveAgentContextWorkspace(config), configuredAgentId(config.agentId ?? "unspecified-agent"));
}

export function verifyAgentContextBeforeAttempt(startupSnapshot) {
	if (!startupSnapshot || startupSnapshot.schemaVersion !== 1 || typeof startupSnapshot.contextHash !== "string" || !Array.isArray(startupSnapshot.manifest?.files)) {
		throw new Error("a valid startup agent context snapshot is required");
	}
	try {
		const entrypoint = startupSnapshot.manifest.files.find((file) => file.kind === "entrypoint");
		const contextFiles = startupSnapshot.manifest.files.filter((file) => file.kind === "context").map((file) => file.path);
		if (!entrypoint || startupSnapshot.manifest.files.filter((file) => file.kind === "entrypoint").length !== 1) throw new Error("startup agent context manifest is invalid");
		const resolvedWorkspace = resolveAgentContextWorkspace({ workspace: startupSnapshot.workspaceRoot, entrypoint: entrypoint.path, contextFiles });
		const current = snapshotResolvedWorkspace(resolvedWorkspace, configuredAgentId(startupSnapshot.agentId));
		if (current.contextHash !== startupSnapshot.contextHash) throw new AgentContextChangedError();
		return Object.freeze({ contextHash: current.contextHash, verified: true });
	} catch (error) {
		if (error instanceof AgentContextChangedError) throw error;
		throw new AgentContextChangedError();
	}
}
