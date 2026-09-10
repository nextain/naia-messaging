#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NATIVE_COMMAND_CONTRACT } from "./native-command-contract.mjs";
import { SessionStore } from "./store.mjs";
import { loadMessengerConfig, FileCredentialResolver } from "./discord-config.mjs";
import { downloadDiscordAttachment, fetchDiscordHistory, sendDiscordReply } from "./discord-history.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "./instance-paths.mjs";
import { evaluateManagedDiscordCanary, manageService, prepareManagedDiscordCutover, restoreManagedDiscordCutover, verifyManagedDiscordCutover } from "./service-manager.mjs";
import { listManagedDiscordArtifacts, pruneManagedDiscordArtifacts } from "./cutover-bundle.mjs";
import { gatewayEvidenceBoundSeconds, projectUnattendedHealth } from "./unattended-health.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";

class UsageError extends Error {}

const cliContract = NATIVE_COMMAND_CONTRACT.cli;

function parseArgs(argv) {
	const positional = [];
	const options = Object.fromEntries(cliContract.boolean_options.map((key) => [key, false]));
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		const key = cliContract.option_flags[value];
		if (key === undefined) {
			if (value.startsWith("--")) throw new UsageError(`unknown option: ${value}`);
			positional.push(value);
			continue;
		}
		if (cliContract.value_options.includes(key)) {
			const next = argv[index + 1];
			if (!next || next.startsWith("--")) throw new UsageError(`${value} requires a value`);
			options[key] = cliContract.numeric_options.includes(key) ? Number(next) : next;
			index += 1;
		} else {
			options[key] = true;
		}
	}
	return { positional, options };
}

function validateInvocation(positional, options) {
	const command = positional[0] ?? "status";
	const allowed = cliContract.command_options[command];
	if (!allowed) throw new UsageError(`unsupported command: ${command}`);
	const allowedOptions = new Set(allowed);
	const expectedPositionals = positional.length === 0 ? 0 : cliContract.positional_arity[command] ?? 1;
	if (positional.length !== expectedPositionals) throw new UsageError(`invalid arguments for ${command}`);
	if (cliContract.actions[command] && !cliContract.actions[command].includes(positional[1])) {
		const actions = cliContract.actions[command];
		const actionDescription = command === "artifacts"
			? actions.join(" or ")
			: actions.length > 1 ? `${actions.slice(0, -1).join(", ")}, or ${actions.at(-1)}` : actions[0];
		throw new UsageError(`${command} requires ${actionDescription}`);
	}
	if (command === "jobs" && options.active && options.failed) throw new UsageError("--active and --failed are mutually exclusive");
	if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000)) throw new UsageError("--limit must be an integer between 1 and 1000");
	for (const [key, value] of Object.entries(options)) {
		if (key === "adkRoot" || key === "instance" || value === false || value === undefined) continue;
		if (!allowedOptions.has(key)) throw new UsageError(`option --${key} is not valid for ${command}`);
	}
	return command;
}

function humanJob(job) {
	return `${job.jobId}  ${job.lifecycle}  ${job.activityHealth.value} (${job.activityHealth.reasonCode})  child=${job.childState?.state ?? "unknown"}  ${job.backendId}  ${job.safeSummary}`;
}

function output(value, jsonMode) {
	if (jsonMode) console.log(JSON.stringify(value, null, 2));
	else if (Array.isArray(value)) value.forEach((item) => console.log(humanJob(item)));
	else console.log(value);
}

let positional;
let options;
let command;
try {
	({ positional, options } = parseArgs(process.argv.slice(2)));
	const knownCommands = new Set(cliContract.known_commands);
	if (positional[0] && !knownCommands.has(positional[0])) {
		if (options.instance) throw new UsageError("instance was specified more than once");
		options.instance = normalizeMessengerInstance(positional.shift());
	}
	command = validateInvocation(positional, options);
} catch (error) {
	console.error(error.message);
	process.exit(error instanceof UsageError ? 2 : 1);
}
const adkRoot = resolve(options.adkRoot ?? process.env.NAIA_ADK_PATH ?? process.cwd());
const instance = normalizeMessengerInstance(options.instance ?? process.env.NAIA_MESSENGER_INSTANCE ?? "default");
const instancePaths = messengerInstancePaths(adkRoot, instance);
const databasePath = instancePaths.databasePath;

if (new Set(["cancel", "restart", "amend", "submit"]).has(command)) {
	try {
		if (command !== "submit" && !options.jobId) throw new UsageError(`--job is required for ${command}`);
		let amendment;
		let content;
		if (command === "amend") {
			if (!options.contentPath) throw new UsageError("--content-file is required for amend");
			const contentPath = resolve(options.contentPath);
			assertOwnerOnly(contentPath, "file", "Discord job amendment");
			amendment = readFileSync(contentPath, "utf8");
			if (!amendment.trim() || amendment.length > 4_000) throw new UsageError("amendment must contain 1 to 4000 characters");
		}
		if (command === "submit") {
			if (!options.contentPath || !options.channelId || !options.authorId) throw new UsageError("--content-file, --channel, and --author are required for submit");
			const contentPath = resolve(options.contentPath);
			assertOwnerOnly(contentPath, "file", "Discord operator submission");
			content = readFileSync(contentPath, "utf8");
			if (!content.trim() || content.length > 4_000) throw new UsageError("submission must contain 1 to 4000 characters");
		}
		if (!existsSync(databasePath)) throw new Error("Discord session state is unavailable");
		const stateStore = SessionStore.openReadOnly(databasePath);
		const generation = stateStore.status().service.generation;
		stateStore.close();
		if (!generation) throw new Error("Discord service generation is unavailable");
		if (existsSync(instancePaths.jobControlRequestPath)) throw new Error("another job control request is pending");
		try { unlinkSync(instancePaths.jobControlReceiptPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
		const requestId = randomUUID();
		const temporary = `${instancePaths.jobControlRequestPath}.${process.pid}.${requestId}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, requestId, generation, action: command, jobId: options.jobId, amendment, channelId: options.channelId, authorId: options.authorId, content, access: command === "submit" && options.readOnly ? "read-only" : null, createdAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
		protectOwnerOnly(temporary, "file", "Discord job control request");
		renameSync(temporary, instancePaths.jobControlRequestPath);
		protectOwnerOnly(instancePaths.jobControlRequestPath, "file", "Discord job control request");
		let receipt = null;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 125));
			if (!existsSync(instancePaths.jobControlReceiptPath)) continue;
			const candidate = JSON.parse(readFileSync(instancePaths.jobControlReceiptPath, "utf8"));
			if (candidate.requestId === requestId) { receipt = candidate; break; }
		}
		if (!receipt) throw new Error("job control receipt deadline exceeded");
		if (options.json) console.log(JSON.stringify({ schemaVersion: 1, command, receipt }, null, 2));
		else console.log(`${receipt.state} action=${receipt.action} job=${receipt.jobId ?? options.jobId} replacement=${receipt.replacementJobId ?? "none"} semantics=${receipt.semantics ?? "direct"} reason=${receipt.reasonCode ?? "none"}`);
		process.exit(receipt.state === "accepted" ? 0 : 4);
	} catch (error) {
		console.error(error.message);
		process.exit(error instanceof UsageError ? 2 : 1);
	}
}

if (command === "service") {
	try {
		const result = manageService({ adkRoot, instance, command: positional[1] });
		if (options.json) console.log(JSON.stringify({ schemaVersion: 1, command, result }, null, 2));
		else console.log(result);
		process.exit(0);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}

if (command === "cutover") {
	try {
		const action = positional[1];
		if (!cliContract.actions.cutover.includes(action)) throw new UsageError("cutover requires prepare, verify, canary, or rollback");
		if (action === "canary" && !options.jobId) throw new UsageError("cutover canary requires --job");
		const result = action === "prepare"
			? prepareManagedDiscordCutover({ adkRoot, instance })
			: action === "verify"
				? verifyManagedDiscordCutover({ adkRoot, instance })
				: action === "canary"
					? evaluateManagedDiscordCanary({ adkRoot, instance, jobId: options.jobId })
					: restoreManagedDiscordCutover({ adkRoot, instance });
		const manifest = result.manifest ?? result;
		if (options.json) console.log(JSON.stringify({ schemaVersion: 1, command, action, result: manifest }, null, 2));
		else if (action === "canary") console.log(`canary=${result.verdict} job=${result.jobId} reasons=${result.reasons.join(",") || "none"}`);
		else console.log(`${action} rollback-bundle=${manifest.bundleId} revision=${manifest.sourceRevision}`);
		process.exit(action === "canary" && result.verdict === "stop" ? 4 : 0);
	} catch (error) {
		console.error(error.message);
		process.exit(error instanceof UsageError ? 2 : 1);
	}
}

if (command === "artifacts") {
	try {
		const action = positional[1];
		if (!cliContract.actions.artifacts.includes(action)) throw new UsageError("artifacts requires list or prune");
		const result = action === "list"
			? listManagedDiscordArtifacts({ adkRoot, instance })
			: pruneManagedDiscordArtifacts({ adkRoot, instance });
		if (options.json) console.log(JSON.stringify({ schemaVersion: 1, command, action, result }, null, 2));
		else if (action === "list") for (const item of result.items) console.log(`${item.state} ${item.kind} ${item.id}`);
		else for (const item of result.removed) console.log(`removed ${item.kind} ${item.id}`);
		process.exit(0);
	} catch (error) {
		console.error(error.message);
		process.exit(error instanceof UsageError ? 2 : 1);
	}
}

let messengerConfig;
if (new Set(["status", "health-check"]).has(command) && (existsSync(databasePath) || instance !== "default" || existsSync(instancePaths.configPath))) {
	try { loadMessengerConfig(instancePaths.configPath); }
	catch (error) {
		console.error(`Discord messenger configuration unavailable: ${error.message}`);
		process.exit(3);
	}
}

if (command === "health-check") {
	try { messengerConfig = loadMessengerConfig(instancePaths.configPath); }
	catch (error) {
		console.error(`Discord messenger configuration unavailable: ${error.message}`);
		process.exit(3);
	}
}

if (command === "history" || command === "latest" || command === "attachment" || command === "reply") {
	try {
		if (!options.channelId) throw new UsageError(`--channel is required for ${command}`);
		const paths = messengerInstancePaths(adkRoot, instance);
		const config = loadMessengerConfig(paths.configPath);
		const token = new FileCredentialResolver(paths.credentialsDirectory).resolve(config.discord.credentialRef);
		if (command === "attachment") {
			for (const [key, flag] of [["messageId", "--message"], ["attachmentId", "--attachment"], ["outputPath", "--output"]]) if (!options[key]) throw new UsageError(`${flag} is required for attachment`);
			const result = await downloadDiscordAttachment({ config, token, channelId: options.channelId, messageId: options.messageId, attachmentId: options.attachmentId, outputPath: options.outputPath, expectedSha256: options.expectedSha256 });
			if (options.json) console.log(JSON.stringify({ schemaVersion: 1, command, result }, null, 2));
			else console.log(`${result.state} ${result.bytes} bytes sha256=${result.sha256}`);
		} else if (command === "reply") {
			if (!options.contentPath) throw new UsageError("--content-file is required for reply");
			const result = await sendDiscordReply({ config, token, channelId: options.channelId, contentPath: options.contentPath });
			if (options.json) console.log(JSON.stringify({ schemaVersion: 1, command, result }, null, 2));
			else console.log(result.state === "confirmed" ? `confirmed messageId=${result.messageId}` : `${result.state} reason=${result.reasonCode}`);
			if (result.state !== "confirmed") process.exitCode = result.state === "failed" ? 4 : 5;
		} else {
			const messages = await fetchDiscordHistory({ config, token, channelId: options.channelId, authorId: options.authorId, limit: options.limit ?? 20, mode: command });
			if (options.json) console.log(JSON.stringify({ schemaVersion: 1, command, messages }, null, 2));
			else if (messages.length === 0) console.log("No authorized Discord messages found.");
			else messages.forEach((message) => console.log(`${message.createdAt ?? "unknown"} ${message.author} (${message.authorId}): ${message.content}`));
		}
		process.exit(process.exitCode ?? 0);
	} catch (error) {
		console.error(error.message);
		process.exit(error instanceof UsageError ? 2 : 1);
	}
}

if (!existsSync(databasePath) && new Set(["status", "health-check"]).has(command)) {
	const empty = {
		schemaVersion: 1,
		service: { state: "stopped", reasonCode: "service_state_missing", observedAt: new Date().toISOString(), heartbeatAt: null, processAlive: null },
		gateway: { resumable: false, sequence: null, lastHeartbeatAckAt: null },
		jobs: { active: 0, suspectedStalled: 0, needsReview: 0 },
		foreignAgentSupervision: "unsupported",
	};
	if (command === "health-check") {
		const health = projectUnattendedHealth({ status: empty, jobs: [], noProgressInterventionSeconds: messengerConfig.runtime.noProgressInterventionSeconds ?? messengerConfig.runtime.softSilenceSeconds ?? 120, gatewayEvidenceStaleSeconds: gatewayEvidenceBoundSeconds(messengerConfig.runtime.heartbeatSeconds ?? 10) });
		if (options.json) console.log(JSON.stringify(health, null, 2));
		else console.log(`health=${health.state} reason=service_state_missing foreignAgents=unsupported`);
		process.exit(4);
	}
	if (options.json) console.log(JSON.stringify(empty, null, 2));
	else console.log("service=stopped reason=service_state_missing active=0 stalled=0 review=0");
	process.exit(0);
}

if (!existsSync(databasePath)) {
	console.error(`No Discord session state at ${databasePath}`);
	process.exit(3);
}

let store;
try {
	store = SessionStore.openReadOnly(databasePath);
} catch (error) {
	console.error(`Discord session state unavailable: ${error.message}`);
	process.exit(3);
}
try {
	if (command === "status") {
		const status = { ...store.status(), foreignAgentSupervision: "unsupported" };
		if (options.json) output(status, true);
		else output(`service=${status.service.state} reason=${status.service.reasonCode} gateway=${status.gateway.resumable ? "resumable" : "fresh_connect"} active=${status.jobs.active} stalled=${status.jobs.suspectedStalled} review=${status.jobs.needsReview} foreignAgents=unsupported`, false);
	} else if (command === "health-check") {
		const health = projectUnattendedHealth({ status: store.status(), jobs: store.listOperationalJobs(), historicalAttention: store.historicalAttentionCounts(), noProgressInterventionSeconds: messengerConfig.runtime.noProgressInterventionSeconds ?? messengerConfig.runtime.softSilenceSeconds ?? 120, gatewayEvidenceStaleSeconds: gatewayEvidenceBoundSeconds(messengerConfig.runtime.heartbeatSeconds ?? 10) });
		if (options.json) output(health, true);
		else output(`health=${health.state} unhealthy=${health.unhealthy.length} attention=${health.attention.length} foreignAgents=${health.foreignAgentSupervision}`, false);
		if (health.state === "unhealthy") process.exitCode = 4;
	} else if (command === "jobs") {
		const limit = options.limit ?? 100;
		const jobs = options.active
			? store.listOperationalJobs({ limit })
			: store.listJobs({ limit, lifecycles: options.failed ? ["failed", "recovery_review"] : null });
		output(options.json ? { schemaVersion: 1, jobs } : jobs, options.json);
	} else if (command === "job") {
		const jobId = positional[1];
		if (!jobId) throw new Error("job id is required");
		const job = store.getJob(jobId, { includeEvents: options.events || options.json });
		if (!job) {
			console.error(`unknown job: ${jobId}`);
			process.exitCode = 2;
		} else if (options.json) output({ schemaVersion: 1, job }, true);
		else {
			console.log(humanJob(job));
			if (options.events) job.events.forEach((event) => console.log(`  ${event.sequence} ${event.occurredAt} ${event.kind} ${event.safeSummary}`));
		}
	} else if (command === "watch" || command === "logs") {
		let cursor = 0;
		const emit = () => {
			const events = store.eventsAfter({ jobId: options.jobId, afterOrdinal: cursor });
			for (const event of events) {
				cursor = Math.max(cursor, event.ordinal);
				if (options.jsonl) console.log(JSON.stringify({ schemaVersion: 1, event }));
				else console.log(`${event.occurredAt} ${event.jobId} ${event.kind} ${event.safeSummary}`);
			}
		};
		emit();
		if (command === "logs" && !options.follow) {
			// Historical log mode exits after replay. --follow keeps tailing the same durable ledger.
		} else if (!options.once) {
			const timer = setInterval(emit, 500);
			process.on("SIGINT", () => {
				clearInterval(timer);
				store.close();
				process.exit(0);
			});
			await new Promise(() => {});
		}
	} else if (command === "monitor") {
		const render = () => {
			const status = store.status();
			const jobs = store.listJobs({ limit: 8 });
			const selected = jobs[0] ?? null;
			const events = selected ? store.getJob(selected.jobId)?.events.slice(-12) ?? [] : [];
			if (process.stdout.isTTY && !options.once) process.stdout.write("\x1b[2J\x1b[H");
			console.log(`${instance} Gateway  service=${status.service.state}  active=${status.jobs.active}  review=${status.jobs.needsReview}`);
			console.log("Jobs (active and recent terminal):");
			if (jobs.length === 0) console.log("  No jobs recorded.");
			for (const job of jobs) console.log(`  ${humanJob(job)}`);
			console.log(selected ? `Latest timeline: ${selected.jobId}` : "Latest timeline:");
			for (const event of events) console.log(`  ${event.occurredAt} ${event.kind} ${event.safeSummary}`);
			if (!options.once) console.log(`\nControls: ${instance} cancel --job <id> | restart --job <id> | amend --job <id> --content-file <path> | submit --channel <id> --author <id> --content-file <path>\nCtrl-C: close monitor (does not stop the Gateway)`);
		};
		render();
		if (!options.once) {
			const timer = setInterval(render, 1_000);
			process.on("SIGINT", () => { clearInterval(timer); store.close(); process.exit(0); });
			await new Promise(() => {});
		}
	} else {
		console.error(`unsupported command: ${command}`);
		process.exitCode = 2;
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	if (!["watch", "logs", "monitor"].includes(command) || options.once || (command === "logs" && !options.follow)) store.close();
}
