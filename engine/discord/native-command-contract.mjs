const optionDefinitions = Object.freeze([
	Object.freeze({ flag: "--json", key: "json", type: "boolean" }),
	Object.freeze({ flag: "--jsonl", key: "jsonl", type: "boolean" }),
	Object.freeze({ flag: "--events", key: "events", type: "boolean" }),
	Object.freeze({ flag: "--once", key: "once", type: "boolean" }),
	Object.freeze({ flag: "--active", key: "active", type: "boolean" }),
	Object.freeze({ flag: "--failed", key: "failed", type: "boolean" }),
	Object.freeze({ flag: "--follow", key: "follow", type: "boolean" }),
	Object.freeze({ flag: "-f", key: "follow", type: "boolean" }),
	Object.freeze({ flag: "--read-only", key: "readOnly", type: "boolean" }),
	Object.freeze({ flag: "--adk-root", key: "adkRoot", type: "value" }),
	Object.freeze({ flag: "--job", key: "jobId", type: "value" }),
	Object.freeze({ flag: "--instance", key: "instance", type: "value" }),
	Object.freeze({ flag: "--channel", key: "channelId", type: "value" }),
	Object.freeze({ flag: "--author", key: "authorId", type: "value" }),
	Object.freeze({ flag: "--limit", key: "limit", type: "number" }),
	Object.freeze({ flag: "--message", key: "messageId", type: "value" }),
	Object.freeze({ flag: "--attachment", key: "attachmentId", type: "value" }),
	Object.freeze({ flag: "--output", key: "outputPath", type: "value" }),
	Object.freeze({ flag: "--expected-sha256", key: "expectedSha256", type: "value" }),
	Object.freeze({ flag: "--content-file", key: "contentPath", type: "value" }),
]);

const command = (options, metadata = {}) => Object.freeze({
	options: Object.freeze([...options]),
	...(metadata.readonly === true ? { readonly: true } : {}),
	...(metadata.positionalArity === undefined ? {} : { positionalArity: metadata.positionalArity }),
	...(metadata.actions === undefined ? {} : { actions: Object.freeze([...metadata.actions]) }),
	...(metadata.readonlyActions === undefined ? {} : { readonlyActions: Object.freeze([...metadata.readonlyActions]) }),
});

const commandDefinitions = Object.freeze({
	status: command(["json"], { readonly: true }),
	"health-check": command(["json"], { readonly: true }),
	jobs: command(["json", "active", "failed", "limit"], { readonly: true }),
	job: command(["json", "events"], { readonly: true, positionalArity: 2 }),
	watch: command(["jsonl", "once", "jobId"], { readonly: true }),
	logs: command(["jsonl", "follow", "jobId"], { readonly: true }),
	monitor: command(["once"], { readonly: true }),
	cancel: command(["json", "jobId"]),
	restart: command(["json", "jobId"]),
	amend: command(["json", "jobId", "contentPath"]),
	submit: command(["json", "channelId", "authorId", "contentPath", "readOnly"]),
	history: command(["json", "channelId", "authorId", "limit"], { readonly: true }),
	latest: command(["json", "channelId", "authorId", "limit"], { readonly: true }),
	attachment: command(["json", "channelId", "messageId", "attachmentId", "outputPath", "expectedSha256"]),
	reply: command(["json", "channelId", "contentPath"]),
	service: command(["json"], {
		positionalArity: 2,
		actions: ["status", "start", "stop", "restart", "install", "enable", "disable", "unit"],
	}),
	cutover: command(["json", "jobId"], {
		positionalArity: 2,
		actions: ["prepare", "verify", "canary", "rollback"],
	}),
	artifacts: command(["json"], {
		positionalArity: 2,
		actions: ["list", "prune"],
		readonlyActions: ["list"],
	}),
});

const commandEntries = Object.entries(commandDefinitions);
const knownCommands = Object.freeze(commandEntries.map(([name]) => name));
const commandOptions = Object.freeze(Object.fromEntries(
	commandEntries.map(([name, definition]) => [name, definition.options]),
));
const positionalArity = Object.freeze(Object.fromEntries(
	commandEntries
		.filter(([, definition]) => definition.positionalArity !== undefined)
		.map(([name, definition]) => [name, definition.positionalArity]),
));
const actions = Object.freeze(Object.fromEntries(
	commandEntries
		.filter(([, definition]) => definition.actions !== undefined)
		.map(([name, definition]) => [name, definition.actions]),
));
const readonlyCommands = Object.freeze(commandEntries.flatMap(([name, definition]) => [
		...(definition.readonly === true ? [name] : []),
		...(definition.readonlyActions ?? []).map((action) => `${name} ${action}`),
]));
const serviceCommands = Object.freeze((commandDefinitions.service.actions ?? []).map((action) => `service ${action}`));
const cutoverCommands = Object.freeze((commandDefinitions.cutover.actions ?? []).map((action) => `cutover ${action}`));

const optionFlags = Object.freeze(Object.fromEntries(optionDefinitions.map(({ flag, key }) => [flag, key])));
const unique = (values) => Object.freeze([...new Set(values)]);
const booleanOptions = unique(optionDefinitions.filter(({ type }) => type === "boolean").map(({ key }) => key));
const valueOptions = unique(optionDefinitions.filter(({ type }) => type !== "boolean").map(({ key }) => key));
const numericOptions = unique(optionDefinitions.filter(({ type }) => type === "number").map(({ key }) => key));

const nativePolicy = Object.freeze({
	cancel: Object.freeze({ command: "cancel", required: ["--job", "<id>"], allow_extra_args: false }),
	attachment: Object.freeze({ command: "attachment", requires: ["--output", "<absolute path>"], policy_operation: "attachment-download", overwrite: false }),
	unsupportedCommands: Object.freeze(["retry"]),
	revision: Object.freeze({ native_cutover_accepts: false, project_high_impact_requires: "one separate 40-character hexadecimal --revision" }),
});

const cli = Object.freeze({
	known_commands: knownCommands,
	option_flags: optionFlags,
	boolean_options: booleanOptions,
	value_options: valueOptions,
	numeric_options: numericOptions,
	command_options: commandOptions,
	positional_arity: positionalArity,
	actions,
});

export const NATIVE_COMMAND_CONTRACT = Object.freeze({
	contract_version: 1,
	runtime: "manage-discord-sessions",
	scope: "wrapper-boundary",
	readonly_commands: readonlyCommands,
	service_commands: serviceCommands,
	cutover_commands: cutoverCommands,
	cancel: nativePolicy.cancel,
	attachment: nativePolicy.attachment,
	unsupported_commands: nativePolicy.unsupportedCommands,
	revision: nativePolicy.revision,
	binding: "The CLI argument contract is defined here; wrappers may expose a narrower policy boundary.",
	cli,
});
