/**
 * Instance config VALIDATION — shape only.
 *
 * The runtime validates the SHAPE of an instance's config; it never ships a
 * config with real values. A secret is referenced by the NAME of the
 * environment variable that holds it, never inline. Bindings, the contact
 * window, and the participant registry are validated with core's own
 * validators, so the runtime and the engine agree on what a valid config is.
 */
import { validateBindings } from "../core/binding.mjs";
import { normaliseContactWindow } from "../core/contact-window.mjs";

const TOP_KEYS = new Set([
	"instance",
	"transport",
	"tokenEnvVar",
	"botUserId",
	"participantsFile",
	"contactWindow",
	"bindings",
	"operators",
	"messageContentIntent",
]);

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Validate an instance config object's shape. Returns a normalised config;
 * throws naming the first problem. Does NOT read secrets — only checks that a
 * secret is referenced by an env-var name.
 */
export function validateInstanceConfig(config) {
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config must be an object");
	// Reject inline secrets first, with a clear message, before the generic
	// unsupported-field check.
	if ("token" in config || "botToken" in config) {
		throw new Error("config must not contain an inline token; reference an env var via tokenEnvVar");
	}
	for (const key of Object.keys(config)) {
		if (!TOP_KEYS.has(key)) throw new Error(`config has unsupported field: ${key}`);
	}
	if (typeof config.instance !== "string" || config.instance.length === 0) throw new Error("config.instance is required");
	if (config.transport !== "discord") throw new Error("config.transport must be a supported transport (discord)");

	// Secrets are referenced, never inlined.
	if (!ENV_VAR_NAME.test(String(config.tokenEnvVar ?? ""))) {
		throw new Error("config.tokenEnvVar must be the NAME of an environment variable, not a token");
	}
	if (config.botUserId !== undefined && !/^\d{17,20}$/.test(String(config.botUserId))) {
		throw new Error("config.botUserId, if present, must be a Discord snowflake");
	}
	if (typeof config.participantsFile !== "string" || config.participantsFile.length === 0) {
		throw new Error("config.participantsFile is required (path to the private registry, not its contents)");
	}
	if (config.operators !== undefined) {
		if (!Array.isArray(config.operators)) throw new Error("config.operators must be an array");
		config.operators.forEach((id) => {
			if (!/^\d{17,20}$/.test(String(id))) throw new Error("each operator must be a Discord snowflake");
		});
	}

	const messageContentIntent = Boolean(config.messageContentIntent);
	const contactWindow = normaliseContactWindow(config.contactWindow);
	const bindings = validateBindings(config.bindings, { canRespondAlways: messageContentIntent });

	return {
		instance: config.instance,
		transport: config.transport,
		tokenEnvVar: config.tokenEnvVar,
		botUserId: config.botUserId ?? null,
		participantsFile: config.participantsFile,
		operators: config.operators ?? [],
		messageContentIntent,
		contactWindow,
		bindings,
	};
}
