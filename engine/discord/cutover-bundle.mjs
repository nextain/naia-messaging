import { acquireDiscordArtifactOperationLock } from "./cutover-artifact-lock.mjs";
import { pruneManagedDiscordArtifacts as pruneManagedDiscordArtifactsImpl } from "./cutover-artifacts.mjs";

export { acquireDiscordArtifactOperationLock };
export {
	createManagedRuntimeArtifact,
	inspectCutoverCandidateRuntime,
	verifyLinuxLegacyRegistration,
	verifyLinuxLegacyRegistrationBinding,
	verifyLinuxManagedRegistration,
	verifyManagedRuntimeArtifact,
	verifyManagedRuntimeLaunch,
} from "./cutover-managed-runtime.mjs";
export {
	activeCutoverRollbackBundle,
	createCutoverRollbackBundle,
	restoreCutoverRollbackBundle,
	validateConfigWithRuntime,
	validateCutoverBootstrap,
	verifyCutoverRollbackBundle,
} from "./cutover-rollback.mjs";
export { listManagedDiscordArtifacts } from "./cutover-artifacts.mjs";
export function pruneManagedDiscordArtifacts(options = {}) {
	return pruneManagedDiscordArtifactsImpl(options, acquireDiscordArtifactOperationLock);
}
export { evaluateCutoverCanary, verifyCutoverController } from "./cutover-canary.mjs";
