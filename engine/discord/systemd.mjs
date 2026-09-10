import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { credentialProfileExecutableDirectories } from "./credential-profiles.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";

function unitQuote(value) {
	if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("systemd value is unsafe");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function discordUnitIdentity(adkRoot, instanceValue = "default") {
	const root = realpathSync(resolve(adkRoot));
	const instance = normalizeMessengerInstance(instanceValue);
	const identity = instance === "default" ? root : `${root}\0${instance}`;
	const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
	return { root, instance, unitName: `naia-discord-sessions-${suffix}.service` };
}

export function renderDiscordUserUnit({ adkRoot, instance = "default", tokenFingerprint, runtimeRevision, runtimeTreeId = null, runtimeArtifactSha256 = null, runtimeArtifactDirectory = null, nodePath = process.execPath, backendExecutables = {}, credentialProfiles = [], homeDirectory = homedir(), servicePath: servicePathOverride = null }) {
	const identity = discordUnitIdentity(adkRoot, instance);
	const { root, unitName } = identity;
	const paths = messengerInstancePaths(root, identity.instance);
	const servicePath = servicePathOverride === null ? resolve(root, ".agents/skills/manage-discord-sessions/helper/service.mjs") : resolve(servicePathOverride);
	if (!isAbsolute(servicePath)) throw new Error("Discord service path must be absolute");
	if (typeof tokenFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(tokenFingerprint)) throw new Error("Discord token fingerprint is required for the kernel token lock");
	if (typeof runtimeRevision !== "string" || !/^[a-f0-9]{40}$/.test(runtimeRevision)) throw new Error("Discord runtime revision is required for the managed service");
	const artifactMarkers = [runtimeTreeId, runtimeArtifactSha256, runtimeArtifactDirectory];
	if (artifactMarkers.some((value) => value !== null)) {
		if (!/^[a-f0-9]{40}$/.test(runtimeTreeId ?? "") || !/^[a-f0-9]{64}$/.test(runtimeArtifactSha256 ?? "")
			|| typeof runtimeArtifactDirectory !== "string" || !isAbsolute(runtimeArtifactDirectory)) throw new Error("Discord managed runtime artifact markers are incomplete");
	}
	const tokenLockPath = `%t/naia-discord-token-${tokenFingerprint}.lock`;
	const exec = ["/usr/bin/flock", "--no-fork", "--nonblock", "--conflict-exit-code", "78", tokenLockPath, "/usr/bin/flock", "--no-fork", "--nonblock", "--conflict-exit-code", "78", paths.lockPath, nodePath, servicePath, "--adk-root", root, "--instance", identity.instance].map(unitQuote).join(" ");
	const backendEnvironment = Object.entries(backendExecutables).map(([backend, executable]) => {
		if (!new Set(["codex", "claude", "opencode", "grok"]).has(backend) || !resolve(executable).startsWith("/")) throw new Error("backend executable must be an absolute supported path");
		return `Environment=${unitQuote(`NAIA_${backend.toUpperCase()}_EXECUTABLE=${resolve(executable)}`)}`;
	});
	const credentialExecutableDirectories = credentialProfileExecutableDirectories(credentialProfiles, { homeDirectory });
	const executablePath = [...new Set([
		dirname(resolve(nodePath)),
		...Object.values(backendExecutables).map((executable) => dirname(resolve(executable))),
		resolve(homeDirectory, ".local/bin"),
		...credentialExecutableDirectories,
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	])].join(delimiter);
	// %t itself outlives each individual unit. Do not put the cross-unit lock in
	// RuntimeDirectory: one sibling stopping could unlink the pathname while a
	// different inode remains locked by another sibling.
	const environment = [
		...backendEnvironment,
		`Environment=${unitQuote("NAIA_DISCORD_LAUNCH_MODE=managed-systemd")}`,
		`Environment=${unitQuote(`NAIA_DISCORD_KERNEL_TOKEN_FINGERPRINT=${tokenFingerprint}`)}`,
		`Environment=${unitQuote(`NAIA_DISCORD_RUNTIME_REVISION=${runtimeRevision}`)}`,
		...(runtimeTreeId === null ? [] : [
			`Environment=${unitQuote(`NAIA_DISCORD_RUNTIME_TREE_ID=${runtimeTreeId}`)}`,
			`Environment=${unitQuote(`NAIA_DISCORD_RUNTIME_SHA256=${runtimeArtifactSha256}`)}`,
			`Environment=${unitQuote(`NAIA_DISCORD_RUNTIME_ARTIFACT=${resolve(runtimeArtifactDirectory)}`)}`,
		]),
		`Environment=${unitQuote(`PATH=${executablePath}`)}`,
	].join("\n");
	const preflight = [nodePath, servicePath, "--managed-preflight"].map(unitQuote).join(" ");
	return { unitName, instance: identity.instance, content: `[Unit]\nDescription=Naia ADK Discord sessions (${identity.instance})\nWants=network-online.target\nAfter=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=3\n\n[Service]\nType=simple\nExecStartPre=${preflight}\nExecStart=${exec}\n${environment ? `${environment}\n` : ""}Restart=always\nRestartPreventExitStatus=78\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n\n[Install]\nWantedBy=default.target\n` };
}

export function renderDiscordSupervisorUnits({ adkRoot, instance = "default", runtimeRevision = null, runtimeTreeId = null, runtimeArtifactSha256 = null, runtimeArtifactDirectory = null, nodePath = process.execPath, supervisorPath: supervisorPathOverride = null }) {
	const identity = discordUnitIdentity(adkRoot, instance);
	const supervisorPath = supervisorPathOverride === null ? resolve(identity.root, ".agents/skills/manage-discord-sessions/helper/supervisor-entry.mjs") : resolve(supervisorPathOverride);
	if (!isAbsolute(supervisorPath)) throw new Error("Discord supervisor path must be absolute");
	const base = identity.unitName.slice(0, -".service".length);
	const serviceName = `${base}-supervisor.service`;
	const timerName = `${base}-supervisor.timer`;
	const exec = [nodePath, supervisorPath, "--adk-root", identity.root, "--instance", identity.instance].map(unitQuote).join(" ");
	const artifactMarkers = [runtimeRevision, runtimeTreeId, runtimeArtifactSha256, runtimeArtifactDirectory];
	if (artifactMarkers.some((value) => value !== null) && (!/^[a-f0-9]{40}$/.test(runtimeRevision ?? "") || !/^[a-f0-9]{40}$/.test(runtimeTreeId ?? "")
		|| !/^[a-f0-9]{64}$/.test(runtimeArtifactSha256 ?? "") || typeof runtimeArtifactDirectory !== "string" || !isAbsolute(runtimeArtifactDirectory))) throw new Error("Discord supervisor managed runtime artifact markers are incomplete");
	const environment = artifactMarkers.every((value) => value !== null) ? [
		`Environment=${unitQuote("NAIA_DISCORD_LAUNCH_MODE=managed-systemd")}`,
		`Environment=${unitQuote(`NAIA_DISCORD_RUNTIME_REVISION=${runtimeRevision}`)}`,
		`Environment=${unitQuote(`NAIA_DISCORD_RUNTIME_TREE_ID=${runtimeTreeId}`)}`,
		`Environment=${unitQuote(`NAIA_DISCORD_RUNTIME_SHA256=${runtimeArtifactSha256}`)}`,
		`Environment=${unitQuote(`NAIA_DISCORD_RUNTIME_ARTIFACT=${resolve(runtimeArtifactDirectory)}`)}`,
	].join("\n") : "";
	return {
		serviceName,
		timerName,
		serviceContent: `[Unit]\nDescription=Naia ADK Discord independent health observer (${identity.instance})\n\n[Service]\nType=oneshot\nExecStart=${exec}\n${environment ? `${environment}\n` : ""}UMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n`,
		timerContent: `[Unit]\nDescription=Naia ADK Discord health observer timer (${identity.instance})\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nAccuracySec=1s\nPersistent=true\nUnit=${serviceName}\n\n[Install]\nWantedBy=timers.target\n`,
	};
}
