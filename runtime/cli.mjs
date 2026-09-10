#!/usr/bin/env node
/**
 * naia-messaging runtime CLI.
 *
 * A thin, config-driven entry point. It does not embed any instance data; it
 * reads a config file the instance owns and validates its shape, and it reads
 * a secret only from the environment variable the config names.
 *
 * Commands:
 *   validate-config <path>   Validate an instance config's shape.
 *   check-token <path>       Report whether the configured token env var is set
 *                            (prints set/unset and length only — never the value).
 */
import fs from "node:fs";
import { validateInstanceConfig } from "./config-schema.mjs";

function readJson(path) {
	if (!path) throw new Error("a config file path is required");
	return JSON.parse(fs.readFileSync(path, "utf8"));
}

function cmdValidateConfig(path) {
	const config = validateInstanceConfig(readJson(path));
	console.log(`config valid: instance='${config.instance}' transport='${config.transport}' bindings=${config.bindings.length}`);
	return 0;
}

function cmdCheckToken(path) {
	const config = validateInstanceConfig(readJson(path));
	const raw = process.env[config.tokenEnvVar];
	if (typeof raw === "string" && raw.length > 0) {
		// Report only presence and length; never the value.
		console.log(`token env '${config.tokenEnvVar}': set (length ${raw.length})`);
		return 0;
	}
	console.error(`token env '${config.tokenEnvVar}': unset`);
	return 1;
}

function main(argv) {
	const [command, ...rest] = argv;
	try {
		switch (command) {
			case "validate-config":
				return cmdValidateConfig(rest[0]);
			case "check-token":
				return cmdCheckToken(rest[0]);
			default:
				console.error("usage: cli.mjs <validate-config|check-token> <config.json>");
				return 2;
		}
	} catch (error) {
		console.error(`error: ${error.message}`);
		return 1;
	}
}

process.exit(main(process.argv.slice(2)));
