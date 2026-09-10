#!/usr/bin/env node
// This bootstrap intentionally imports only Node built-ins. Managed service
// launches verify the complete immutable runtime before any sibling module is
// evaluated, so a modified helper cannot run before the integrity boundary.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FAILURE_REASONS = new Set([
	"configuration_invalid",
	"context_invalid",
	"credential_unavailable",
	"discord_token_already_owned",
	"discord_token_lock_unavailable",
	"context_changed_restart_required",
	"startup_or_runtime_failure",
	"failure_status_invalid",
]);

let loadedRuntime = null;

function startupFailure(reasonCode) {
	const error = new Error(reasonCode);
	error.serviceReasonCode = reasonCode;
	return error;
}

function assertOwnerOnlyBootstrap(path, kind, label) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) throw new Error(`${label} has an invalid filesystem type`);
	if (process.platform !== "win32") {
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
		if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
	}
}

function hashRuntimeTree(root) {
	const hash = createHash("sha256");
	const visit = (directory, prefix = "") => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const path = join(directory, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error("managed runtime contains a symbolic link");
			if (stat.isDirectory()) visit(path, relativePath);
			else if (stat.isFile()) {
				const bytes = readFileSync(path);
				const mode = stat.mode & 0o111 ? "100755" : "100644";
				hash.update(`${mode}\0${relativePath}\0${bytes.length}\0`, "utf8");
				hash.update(bytes);
			} else throw new Error("managed runtime contains an unsupported filesystem entry");
		}
	};
	visit(root);
	return hash.digest("hex");
}

function verifyManagedBootstrap({ environment, runtimePath }) {
	const artifactDirectory = environment.NAIA_DISCORD_RUNTIME_ARTIFACT;
	const expectedRevision = environment.NAIA_DISCORD_RUNTIME_REVISION;
	const expectedTreeId = environment.NAIA_DISCORD_RUNTIME_TREE_ID;
	const expectedSha256 = environment.NAIA_DISCORD_RUNTIME_SHA256;
	if (environment.NAIA_DISCORD_LAUNCH_MODE !== "managed-systemd"
		|| typeof artifactDirectory !== "string" || !isAbsolute(artifactDirectory)
		|| !/^[a-f0-9]{40}$/.test(expectedRevision ?? "")
		|| !/^[a-f0-9]{40}$/.test(expectedTreeId ?? "")
		|| !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) throw new Error("managed Discord runtime launch markers are missing");
	const root = realpathSync(resolve(artifactDirectory));
	if (root !== resolve(artifactDirectory)) throw new Error("managed Discord runtime artifact path is not canonical");
	const manifestPath = join(root, "runtime-artifact.json");
	const expectedRuntimePath = join(root, "runtime/manage-discord-sessions");
	assertOwnerOnlyBootstrap(root, "directory", "managed runtime artifact");
	assertOwnerOnlyBootstrap(manifestPath, "file", "managed runtime manifest");
	assertOwnerOnlyBootstrap(expectedRuntimePath, "directory", "managed runtime");
	if (realpathSync(runtimePath) !== realpathSync(expectedRuntimePath)) throw new Error("service is not executing its managed runtime artifact");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest?.schemaVersion !== 1 || manifest.sourceRevision !== expectedRevision
		|| manifest.sourceRuntimeTreeId !== expectedTreeId || manifest.runtimeSha256 !== expectedSha256
		|| !/^[a-f0-9]{64}$/.test(manifest.runtimeSha256 ?? "")) throw new Error("managed Discord runtime manifest is invalid");
	if (hashRuntimeTree(expectedRuntimePath) !== manifest.runtimeSha256) throw new Error("managed Discord runtime digest mismatch");
	return manifest.sourceRevision;
}

function parseServiceArguments(argv) {
	const rootIndex = argv.indexOf("--adk-root");
	const instanceIndex = argv.indexOf("--instance");
	if (rootIndex < 0 || !argv[rootIndex + 1] || argv[rootIndex + 1].startsWith("--")) throw new Error("--adk-root is required");
	if (instanceIndex >= 0 && (!argv[instanceIndex + 1] || argv[instanceIndex + 1].startsWith("--"))) throw new Error("--instance requires a value");
	if (argv.length !== (instanceIndex >= 0 ? 4 : 2)) throw new Error("unsupported service arguments");
	const instance = instanceIndex >= 0 ? argv[instanceIndex + 1] : "default";
	if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(instance)) throw new Error("instance is invalid");
	return { adkRoot: resolve(argv[rootIndex + 1]), instance };
}

async function runtimeModule() {
	loadedRuntime ??= await import("./service-runtime.mjs");
	return loadedRuntime;
}

export function verifyManagedServiceRuntimeEnvironment({ environment = process.env, runtimePath = realpathSync(fileURLToPath(new URL("../../../", import.meta.url))), allowDirect = false } = {}) {
	try {
		if (environment.NAIA_DISCORD_LAUNCH_MODE === "direct") {
			const managedMarkers = ["NAIA_DISCORD_RUNTIME_ARTIFACT", "NAIA_DISCORD_RUNTIME_REVISION", "NAIA_DISCORD_RUNTIME_TREE_ID", "NAIA_DISCORD_RUNTIME_SHA256"];
			if (!allowDirect || managedMarkers.some((key) => environment[key] !== undefined)) throw new Error("direct Discord runtime launch markers are invalid");
			return null;
		}
		return verifyManagedBootstrap({ environment, runtimePath });
	} catch { throw startupFailure("startup_or_runtime_failure"); }
}

export function isSqliteBusyError(error) {
	return error?.errcode === 5 || error?.code === "SQLITE_BUSY" || (error?.code === "ERR_SQLITE_ERROR" && /database (?:is )?locked/i.test(error?.message ?? ""));
}

export function heartbeatServiceSafely(store, input, { onBusy = () => console.error("naia-discord-service: heartbeat_sqlite_busy_skipped") } = {}) {
	try { store.heartbeatService(input); return true; }
	catch (error) { if (!isSqliteBusyError(error)) throw error; onBusy(); return false; }
}

export async function cleanupDiscordServiceResources(input) {
	return (await runtimeModule()).cleanupDiscordServiceResources(input);
}

export function classifyDiscordServiceFailure(error) {
	if (error?.code === "DISCORD_TOKEN_ALREADY_OWNED") return "discord_token_already_owned";
	if (error?.code === "DISCORD_TOKEN_LOCK_UNAVAILABLE") return "discord_token_lock_unavailable";
	if (error?.code === "context_changed_restart_required") return "context_changed_restart_required";
	if (new Set(["configuration_invalid", "context_invalid", "credential_unavailable"]).has(error?.serviceReasonCode)) return error.serviceReasonCode;
	return "startup_or_runtime_failure";
}

export async function writeDiscordServiceFailure(paths, reasonCode) {
	if (!FAILURE_REASONS.has(reasonCode)) throw new Error("unsupported Discord service failure reason");
	return (await runtimeModule()).writeDiscordServiceFailure(paths, reasonCode);
}

export async function runDiscordService({ runtimeLaunch = "direct", ...options } = {}) {
	const environment = runtimeLaunch === "direct" ? { NAIA_DISCORD_LAUNCH_MODE: "direct" } : process.env;
	const managedRuntimeRevision = verifyManagedServiceRuntimeEnvironment({ environment, allowDirect: runtimeLaunch === "direct" });
	const runtime = await runtimeModule();
	return runtime.runDiscordService({ ...options, managedRuntimeRevision });
}

export function runtimeLaunchForEntrypoint(environment = process.env, platform = process.platform) {
	return platform === "win32" && environment.NAIA_DISCORD_LAUNCH_MODE === "direct" ? "direct" : "environment";
}

export async function serviceMain() {
	let exitCode = 0;
	let serviceArguments = null;
	try {
		if (process.argv.length === 3 && process.argv[2] === "--managed-preflight") verifyManagedServiceRuntimeEnvironment();
		else {
			serviceArguments = parseServiceArguments(process.argv.slice(2));
			await runDiscordService({ ...serviceArguments, runtimeLaunch: runtimeLaunchForEntrypoint() });
		}
	} catch (error) {
		const reasonCode = classifyDiscordServiceFailure(error);
		console.error(`naia-discord-service: ${reasonCode}`);
		if (serviceArguments && loadedRuntime) {
			try {
				const { messengerInstancePaths } = await import("./instance-paths.mjs");
				await loadedRuntime.writeDiscordServiceFailure(messengerInstancePaths(serviceArguments.adkRoot, serviceArguments.instance), reasonCode);
			} catch { console.error("naia-discord-service: failure_status_unavailable"); }
		}
		exitCode = reasonCode === "startup_or_runtime_failure" ? 1 : 78;
	}
	process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await serviceMain();
