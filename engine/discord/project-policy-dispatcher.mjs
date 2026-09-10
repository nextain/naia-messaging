import { isAbsolute, resolve } from "node:path";
import { ProjectPolicyBridge, projectPolicyError } from "./project-policy-bridge.mjs";
import {
	digestManifest,
	digestManifestConfiguration,
	invalidManifest,
	ownerFile,
	readCheckedManifest,
	selectRoute,
} from "./project-policy-route-registry.mjs";

function boundedPath(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 4_096
		&& value.trim() === value && !/[\0\r\n]/.test(value) && isAbsolute(value);
}

export class OwnerProjectPolicyDispatcher {
	constructor({ routeManifest, bridgeScript = null, nodePath = process.execPath, timeoutMs = null } = {}) {
		if (!boundedPath(routeManifest) || (bridgeScript !== null && !boundedPath(bridgeScript)) || !boundedPath(nodePath)) {
			throw invalidManifest();
		}
		this.routeManifest = resolve(routeManifest);
		this.bridgeScriptOverride = bridgeScript;
		this.nodePath = nodePath;
		this.timeoutMsOverride = timeoutMs;
		this.runtimeRevision();
	}

	#checkedManifest() {
		const checked = readCheckedManifest(this.routeManifest);
		if (this.bridgeScriptOverride !== null && checked.bridgeScript !== this.bridgeScriptOverride) throw invalidManifest();
		if (this.timeoutMsOverride !== null && this.timeoutMsOverride !== checked.timeoutMs) throw invalidManifest();
		return checked;
	}

	runtimeRevision() {
		return digestManifest(this.#checkedManifest());
	}

	runtimeConfigurationRevision() {
		return digestManifestConfiguration(this.#checkedManifest());
	}

	check(input) {
		if (input?.access === "read-only") throw projectPolicyError("project_policy_participant_rejected");
		try {
			const checked = this.#checkedManifest();
			const route = selectRoute(checked, input);
			if (!route.enabled) throw projectPolicyError("project_policy_participant_rejected");
			if (!route.usable) throw invalidManifest();
			// Only the authenticated actor's route is read. Other actors can be
			// unavailable or revoked without taking down this dispatcher.
			ownerFile(route.routeFile, "project policy route", 512 * 1024);
			return new ProjectPolicyBridge({
				routeFile: route.routeFile,
				bridgeScript: checked.bridgeScript,
				participantProfile: route.participantProfile,
				nodePath: this.nodePath,
				timeoutMs: checked.timeoutMs,
			}).check(input);
		} catch (error) {
			if (error?.projectPolicy) throw error;
			throw projectPolicyError("project_policy_route_unavailable");
		}
	}
}

export function createConfiguredProjectPolicy({ config, root: _root = null, nodePath = process.execPath } = {}) {
	const configured = config?.projectPolicy;
	if (configured === undefined || configured === null) return null;
	if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw invalidManifest();
	return new OwnerProjectPolicyDispatcher({
		routeManifest: configured.routeManifest,
		bridgeScript: configured.bridgeScript,
		nodePath,
		timeoutMs: configured.timeoutMs ?? null,
	});
}

export function projectPolicyRuntimeRevision(projectPolicy) {
	if (projectPolicy === null || projectPolicy === undefined) return null;
	if (typeof projectPolicy.runtimeConfigurationRevision === "function") return projectPolicy.runtimeConfigurationRevision();
	if (typeof projectPolicy.runtimeRevision !== "function") return null;
	return projectPolicy.runtimeRevision();
}
