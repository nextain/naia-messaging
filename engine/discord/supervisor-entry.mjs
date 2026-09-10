#!/usr/bin/env node
// Managed observer bootstrap: validate the immutable runtime with the service's
// built-in-only preflight before evaluating any observer helper module.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyManagedServiceRuntimeEnvironment } from "./service.mjs";

function argumentsFor(argv) {
	const rootIndex = argv.indexOf("--adk-root");
	const instanceIndex = argv.indexOf("--instance");
	if (rootIndex < 0 || !argv[rootIndex + 1] || argv[rootIndex + 1].startsWith("--")) throw new Error("--adk-root is required");
	if (instanceIndex >= 0 && (!argv[instanceIndex + 1] || argv[instanceIndex + 1].startsWith("--"))) throw new Error("--instance requires a value");
	if (argv.length !== (instanceIndex >= 0 ? 4 : 2) || argv.includes("--loop")) throw new Error("unsupported supervisor arguments");
	const instance = instanceIndex >= 0 ? argv[instanceIndex + 1] : "default";
	if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(instance)) throw new Error("instance is invalid");
	return { adkRoot: resolve(argv[rootIndex + 1]), instance };
}

export async function supervisorEntryMain() {
	try {
		const options = argumentsFor(process.argv.slice(2));
		verifyManagedServiceRuntimeEnvironment();
		const { observeOnce } = await import("./supervisor.mjs");
		const result = observeOnce({ ...options, runtimeLaunch: "environment" });
		console.log(JSON.stringify(result));
		process.exitCode = result.state === "unhealthy" ? 4 : 0;
	} catch (error) {
		console.error(`naia-discord-supervisor: ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await supervisorEntryMain();
