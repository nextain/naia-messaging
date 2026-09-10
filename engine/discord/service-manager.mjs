#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manageLinuxService } from "./service-manager-linux.mjs";
import { manageWindowsService } from "./service-manager-windows.mjs";

export { installSupervisedPair, resolveBackendExecutable } from "./service-manager-shared.mjs";
export { installOperatorLauncher, renderOperatorLauncher } from "./service-manager-launcher.mjs";
export {
	classifyWindowsStopObservation,
	classifyWindowsTaskQuery,
	containWindowsTask,
	quoteWindowsTaskAction,
	renderWindowsStartupLauncher,
	resolveWindowsBackendCommand,
	restartWindowsTask,
	sampleWindowsStopObservation,
	startWindowsTask,
	verifyWindowsTaskAction,
	verifyWindowsTaskDisabled,
	verifyWindowsTaskEnabled,
	windowsSupervisorTaskName,
} from "./service-manager-windows.mjs";
export { authorizeManagedServiceInstall, installServiceCommands, installSupervisorTimerCommands, removeUnreferencedManagedRuntimeArtifact, verifyLinuxInstallOutcome } from "./service-manager-linux.mjs";
export {
	cutoverRegistrationRestoreCommands,
	evaluateManagedDiscordCanary,
	inspectCutoverRuntimeTree,
	normalizeCutoverRegistrationState,
	prepareManagedDiscordCutover,
	readCutoverSourceConfig,
	readCutoverSourceSnapshot,
	resolveCutoverBackendExecutables,
	resolveManagedCutoverSource,
	restoreManagedDiscordCutover,
	verifyCutoverSourceIdentity,
	verifyCutoverSourceSnapshot,
	verifyManagedDiscordCutover,
} from "./service-cutover-controller.mjs";

export function manageService(options) {
	return process.platform === "win32" ? manageWindowsService(options) : manageLinuxService(options);
}

export function serviceManagerMain() {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf("--adk-root");
	const instanceIndex = args.indexOf("--instance");
	try {
		if (rootIndex < 0 || !args[rootIndex + 1]) throw new Error("--adk-root is required");
		if (instanceIndex < 0 || !args[instanceIndex + 1]) throw new Error("--instance is required");
		const excluded = new Set([rootIndex, rootIndex + 1, instanceIndex, instanceIndex + 1]);
		const command = args.find((value, index) => !excluded.has(index) && !value.startsWith("--"));
		console.log(manageService({ adkRoot: resolve(args[rootIndex + 1]), instance: args[instanceIndex + 1], command }));
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) serviceManagerMain();
