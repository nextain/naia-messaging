import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function installSupervisedPair({ installSupervisor, installService, quarantinePair }) {
	if (![installSupervisor, installService, quarantinePair].every((value) => typeof value === "function")) throw new Error("supervised installation callbacks are required");
	try {
		const supervisor = installSupervisor();
		return { supervisor, service: installService(supervisor) };
	} catch (error) {
		try { quarantinePair(); }
		catch (quarantineError) { throw new Error(`${error.message}; supervised pair quarantine failed: ${quarantineError.message}`); }
		throw error;
	}
}

export function resolveBackendExecutable(name, pathValue = process.env.PATH ?? "") {
	if (!new Set(["codex", "claude", "opencode", "grok"]).has(name)) throw new Error("unsupported backend executable");
	const extensions = process.platform === "win32"
		? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.toLowerCase())]
		: [""];
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const candidate = resolve(directory, `${name}${extension}`);
			try {
				accessSync(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
				const executable = realpathSync(candidate);
				if (!isAbsolute(executable) || !statSync(executable).isFile()) continue;
				return executable;
			} catch {}
		}
	}
	throw new Error(`${name} executable was not found in the installer PATH`);
}

export function gitHeadRevision(root) {
	const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
	if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout.trim())) throw new Error("cutover Git revision is unavailable");
	return result.stdout.trim();
}

export function candidateControllerRoot() {
	return realpathSync(resolve(fileURLToPath(new URL("../../../../../../", import.meta.url))));
}
