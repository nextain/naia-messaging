import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BACKENDS, projectPolicyError } from "./project-policy-bridge.mjs";
import { assertOwnerOnly } from "./platform-security.mjs";

const SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ROUTE_BYTES = 512 * 1024;
const MAX_ROUTES = 64;
const SNOWFLAKE = /^\d{17,20}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const BINDING = /^[^\0\r\n]{1,512}$/;
const MANIFEST_KEYS = new Set(["schemaVersion", "enabled", "bridgeScript", "timeoutMs", "routes"]);
const ROUTE_KEYS = new Set(["enabled", "routeFile", "project", "actorAlias", "participantUserId", "bindingIdentity", "backendId", "participantProfile"]);
const PROFILE_KEYS = new Set(["discordUserId", "alias", "project"]);

function boundedString(value, maximum) {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\0\r\n]/.test(value);
}

export function invalidManifest() {
	return projectPolicyError("project_policy_route_unavailable");
}

function exactKeys(value, keys) {
	return value && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).every((key) => keys.has(key));
}

export function ownerFile(path, label, maximum) {
	if (!boundedString(path, 4_096) || !isAbsolute(path)) throw invalidManifest();
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw invalidManifest();
		assertOwnerOnly(path, "file", label);
		return readFileSync(path);
	} catch (error) {
		if (error?.projectPolicy) throw error;
		throw invalidManifest();
	}
}

function ownerJson(path, label, maximum) {
	const bytes = ownerFile(path, label, maximum);
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw invalidManifest();
	}
}

function validateProfile(profile, route) {
	if (!exactKeys(profile, PROFILE_KEYS) || Object.keys(profile).length !== PROFILE_KEYS.size) throw invalidManifest();
	if (!SNOWFLAKE.test(profile.discordUserId) || profile.discordUserId !== route.participantUserId) throw invalidManifest();
	if (!boundedString(profile.alias, 128) || profile.alias !== route.actorAlias || !IDENTIFIER.test(profile.alias)) throw invalidManifest();
	if (!boundedString(profile.project, 128) || profile.project !== route.project || !IDENTIFIER.test(profile.project)) throw invalidManifest();
	return Object.freeze({ ...profile });
}

function validateRouteEntry(route) {
	const validShape = exactKeys(route, ROUTE_KEYS) && route.enabled === true;
	const normalized = {
		enabled: validShape,
		routeFile: boundedString(route?.routeFile, 4_096) && isAbsolute(route.routeFile) ? route.routeFile : "",
		project: boundedString(route?.project, 128) && IDENTIFIER.test(route.project) ? route.project : "",
		actorAlias: boundedString(route?.actorAlias, 128) && IDENTIFIER.test(route.actorAlias) ? route.actorAlias : "",
		participantUserId: SNOWFLAKE.test(route?.participantUserId ?? "") && !/^0+$/.test(route.participantUserId) ? route.participantUserId : "",
		bindingIdentity: boundedString(route?.bindingIdentity, 512) && BINDING.test(route.bindingIdentity) ? route.bindingIdentity : "",
		backendId: BACKENDS.has(route?.backendId) ? route.backendId : "",
		participantProfile: null,
		usable: false,
	};
	if (!validShape || !normalized.routeFile || !normalized.project || !normalized.actorAlias
		|| !normalized.participantUserId || !normalized.bindingIdentity || !normalized.backendId) return Object.freeze(normalized);
	try {
		normalized.participantProfile = validateProfile(route.participantProfile, normalized);
		normalized.usable = true;
	} catch {
		// Preserve an actor identity marker so an invalid route cannot stop others.
	}
	return Object.freeze(normalized);
}

function validateManifest(manifest, manifestPath) {
	if (!exactKeys(manifest, MANIFEST_KEYS) || manifest.schemaVersion !== SCHEMA_VERSION || manifest.enabled !== true) throw invalidManifest();
	if (!boundedString(manifest.bridgeScript, 4_096) || !isAbsolute(manifest.bridgeScript)) throw invalidManifest();
	if (manifest.timeoutMs !== undefined && (!Number.isSafeInteger(manifest.timeoutMs) || manifest.timeoutMs < 1 || manifest.timeoutMs > 60_000)) throw invalidManifest();
	if (!Array.isArray(manifest.routes) || manifest.routes.length === 0 || manifest.routes.length > MAX_ROUTES) throw invalidManifest();
	const bridgeBytes = ownerFile(manifest.bridgeScript, "project policy bridge", MAX_ROUTE_BYTES);
	const routes = manifest.routes.map(validateRouteEntry);
	const identities = new Set();
	for (const route of routes) {
		if (!route.participantUserId || !route.bindingIdentity || !route.backendId) continue;
		const identity = `${route.participantUserId}\u0000${route.bindingIdentity}\u0000${route.backendId}`;
		if (identities.has(identity)) throw invalidManifest();
		identities.add(identity);
	}
	return Object.freeze({
		manifestPath,
		bridgeScript: manifest.bridgeScript,
		bridgeBytes,
		timeoutMs: manifest.timeoutMs ?? 5_000,
		routes: Object.freeze(routes),
	});
}

export function digestManifest(checked) {
	const hash = createHash("sha256");
	hash.update("naia-project-policy-routes-v1\0", "utf8");
	hash.update(checked.manifestPath, "utf8");
	hash.update("\0", "utf8");
	hash.update(checked.bridgeScript, "utf8");
	hash.update(checked.bridgeBytes);
	hash.update(`\0timeoutMs=${checked.timeoutMs}\0`, "utf8");
	for (const route of checked.routes) {
		let routeState = "unusable";
		let routeBytes = null;
		if (route.usable) {
			try {
				routeBytes = ownerFile(route.routeFile, "project policy route", MAX_ROUTE_BYTES);
				routeState = "available";
			} catch {
				routeState = "unavailable";
			}
		}
		hash.update(JSON.stringify({ ...route, routeState, routeBytes: undefined }), "utf8");
		if (routeBytes) hash.update(routeBytes);
	}
	return hash.digest("hex");
}

// Manifest and bridge changes alter the service's routing contract and require
// a restart. Route-file contents and availability remain actor-local runtime
// inputs: the dispatcher reads only the selected route during each phase so a
// revoked or unavailable actor cannot invalidate unrelated participants.
export function digestManifestConfiguration(checked) {
	const hash = createHash("sha256");
	hash.update("naia-project-policy-config-v1\0", "utf8");
	hash.update(checked.manifestPath, "utf8");
	hash.update("\0", "utf8");
	hash.update(checked.bridgeScript, "utf8");
	hash.update(checked.bridgeBytes);
	hash.update(`\0timeoutMs=${checked.timeoutMs}\0`, "utf8");
	for (const route of checked.routes) {
		hash.update(JSON.stringify(route), "utf8");
		hash.update("\0", "utf8");
	}
	return hash.digest("hex");
}

export function readCheckedManifest(manifestPath) {
	return validateManifest(ownerJson(manifestPath, "project policy route manifest", MAX_MANIFEST_BYTES), manifestPath);
}

export function selectRoute(checked, input) {
	const route = checked.routes.find((candidate) => candidate.participantUserId === input?.participantUserId
		&& candidate.bindingIdentity === input?.bindingIdentity && candidate.backendId === input?.backendId);
	if (!route) throw projectPolicyError("project_policy_participant_rejected");
	return route;
}
