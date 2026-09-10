// Credential profiles are deliberately defined in trusted code rather than in
// messenger JSON. Adding another CLI requires one registry entry here, while a
// gateway config can only select a known profile ID.
export const CREDENTIAL_PROFILES = Object.freeze({
	vercel: Object.freeze({
		kind: "file",
		source: [".local", "share", "com.vercel.cli", "auth.json"],
		target: { base: "xdgData", parts: ["com.vercel.cli", "auth.json"] },
		executableDirectories: Object.freeze([
			Object.freeze({ base: "absolute", path: "/home/linuxbrew/.linuxbrew/bin" }),
			Object.freeze({ base: "absolute", path: "/var/home/linuxbrew/.linuxbrew/bin" }),
		]),
		env: Object.freeze({ VERCEL_TELEMETRY_DISABLED: "1" }),
		label: "Vercel authentication",
	}),
	gh: Object.freeze({
		kind: "file",
		source: [".config", "gh", "hosts.yml"],
		target: { base: "xdgConfig", parts: ["gh", "hosts.yml"] },
		executableDirectories: Object.freeze([
			Object.freeze({ base: "absolute", path: "/home/linuxbrew/.linuxbrew/bin" }),
			Object.freeze({ base: "absolute", path: "/var/home/linuxbrew/.linuxbrew/bin" }),
		]),
		label: "GitHub CLI authentication",
	}),
	"ssh-ed25519": Object.freeze({
		kind: "file",
		source: [".ssh", "id_ed25519"],
		target: { base: "home", parts: [".ssh", "id_ed25519"] },
		env: Object.freeze({ TMPDIR: "/tmp" }),
		label: "Ed25519 SSH authentication",
	}),
	gcloud: Object.freeze({
		kind: "directory",
		source: [".config", "gcloud"],
		target: { base: "home", parts: [".config", "gcloud"] },
		exclude: Object.freeze(["logs", "cache", "surface_data"]),
		executableDirectories: Object.freeze([
			Object.freeze({ base: "home", parts: ["google-cloud-sdk", "bin"] }),
		]),
		envPath: Object.freeze({ CLOUDSDK_CONFIG: "target" }),
		env: Object.freeze({ CLOUDSDK_CORE_DISABLE_PROMPTS: "1" }),
		label: "gcloud authentication",
	}),
	az: Object.freeze({
		kind: "directory",
		source: [".azure"],
		target: { base: "home", parts: [".azure"] },
		exclude: Object.freeze(["logs", "cache", "surface_data"]),
		executableDirectories: Object.freeze([
			Object.freeze({ base: "absolute", path: "/home/linuxbrew/.linuxbrew/bin" }),
			Object.freeze({ base: "absolute", path: "/var/home/linuxbrew/.linuxbrew/bin" }),
		]),
		envPath: Object.freeze({ AZURE_CONFIG_DIR: "target" }),
		label: "Azure CLI authentication",
	}),
});

export const CREDENTIAL_PROFILE_IDS = Object.freeze(Object.keys(CREDENTIAL_PROFILES));

const profileAliases = new Map();

// Only trusted consumer code may register legacy names. Messenger JSON can
// select an existing profile but cannot create credentials or filesystem paths.
export function registerCredentialProfileAlias(alias, target) {
    if (typeof alias !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(alias) || CREDENTIAL_PROFILE_IDS.includes(alias)
        || !CREDENTIAL_PROFILE_IDS.includes(target) || (profileAliases.has(alias) && profileAliases.get(alias) !== target)) {
        throw new Error("invalid credential profile alias");
    }
    profileAliases.set(alias, target);
}

export function validateCredentialProfiles(value, label = "credential profiles") {
	if (value === undefined) return [];
	const supported = new Set(CREDENTIAL_PROFILE_IDS);
	const resolved = Array.isArray(value) ? value.map(item => profileAliases.get(item) ?? item) : null;
    if (!resolved || resolved.some((item) => !supported.has(item)) || new Set(resolved).size !== resolved.length) {
		throw new Error(`${label} contains an unsupported credential profile`);
	}
	return resolved;
}

export function credentialProfileExecutableDirectories(value, { homeDirectory } = {}) {
	const profiles = validateCredentialProfiles(value, "executable credential profiles");
	if (typeof homeDirectory !== "string" || !homeDirectory.startsWith("/")) throw new Error("credential executable home directory must be absolute");
	const directories = [];
	for (const profileId of profiles) {
		for (const descriptor of CREDENTIAL_PROFILES[profileId].executableDirectories ?? []) {
			if (descriptor.base === "absolute" && typeof descriptor.path === "string" && descriptor.path.startsWith("/")) directories.push(descriptor.path);
			else if (descriptor.base === "home" && Array.isArray(descriptor.parts) && descriptor.parts.every((part) => typeof part === "string" && part && part !== "." && part !== ".." && !part.includes("/"))) directories.push([homeDirectory, ...descriptor.parts].join("/"));
			else throw new Error("credential executable directory descriptor is invalid");
		}
	}
	return [...new Set(directories)];
}
