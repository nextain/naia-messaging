import { sameExecutionProfile } from "./execution-profile.mjs";

const EXECUTION_ACCESS_LEVELS = new Set(["read-only", "workspace-write", "danger-full-access"]);

export function jobRevisionForExecutionProfile(config, runtimeRevision, executionProfile) {
	const revisionBase = config.schemaVersion === 2 ? `discord-v2-${executionProfile.access}` : "discord-v1";
	const managedRevisionBase = executionProfile.access === "read-only" ? "v2r" : "v2w";
	return runtimeRevision === null ? revisionBase : config.schemaVersion === 2 ? `${managedRevisionBase}:${runtimeRevision}` : `${revisionBase}:${runtimeRevision}`;
}

export function sameExecutionProfileExceptAccess(left, right) {
	if (!left || !right || !EXECUTION_ACCESS_LEVELS.has(left.access) || !EXECUTION_ACCESS_LEVELS.has(right.access)) return false;
	return sameExecutionProfile({ ...left, access: right.access }, { ...right, access: right.access });
}
