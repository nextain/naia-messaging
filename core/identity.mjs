/**
 * Participants and identity — transport-neutral.
 *
 * A participant is a person the engine may converse with. The canonical
 * display identity is `[alias/project]`: the alias is a stable, human-chosen
 * handle scoped to a project, never a platform user id. Platform user ids
 * (Discord snowflakes, a future messenger's account ids) belong to an adapter
 * binding, not to core identity, and are never rendered to people.
 *
 * The registry itself (who maps to which platform id) is INSTANCE
 * configuration and never ships in this repository. Core only defines the
 * shape and the two invariants a schema cannot express:
 *   - an alias is unique within its project;
 *   - a sender resolves to exactly one default workspace.
 */

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Render the canonical `[alias/project]` label. Never emits a platform id. */
export function formatIdentity({ alias, project }) {
	if (!ALIAS_PATTERN.test(String(alias ?? ""))) throw new Error("alias is not a valid handle");
	if (!PROJECT_PATTERN.test(String(project ?? ""))) throw new Error("project is not a valid name");
	return `[${alias}/${project}]`;
}

/**
 * Validate a participant registry object against the shape and the two
 * cross-row invariants. Accepts the parsed object, returns the normalised
 * participant list, and throws on the first violation.
 *
 * @param {{participants: Array<object>}} registry
 */
export function validateParticipantRegistry(registry) {
	const list = registry?.participants;
	if (!Array.isArray(list)) throw new Error("registry.participants must be an array");

	const aliasByProject = new Map(); // project -> Set(alias)
	const workspacesBySender = new Map(); // platformUserId -> Set(workspace)
	const normalised = [];

	for (const [index, entry] of list.entries()) {
		if (!entry || typeof entry !== "object") throw new Error(`participant ${index} must be an object`);
		const { platformUserId, alias, project, workspace, enabled = true } = entry;
		if (typeof platformUserId !== "string" || platformUserId.length === 0) {
			throw new Error(`participant ${index}: platformUserId is required`);
		}
		if (!ALIAS_PATTERN.test(String(alias ?? ""))) throw new Error(`participant ${index}: invalid alias`);
		if (typeof project !== "string" || project.length === 0) throw new Error(`participant ${index}: project is required`);
		if (typeof workspace !== "string" || workspace.length === 0) throw new Error(`participant ${index}: workspace is required`);
		if (typeof enabled !== "boolean") throw new Error(`participant ${index}: enabled must be boolean`);

		const aliases = aliasByProject.get(project) ?? new Set();
		if (aliases.has(alias)) throw new Error(`alias '${alias}' is not unique within project '${project}'`);
		aliases.add(alias);
		aliasByProject.set(project, aliases);

		const workspaces = workspacesBySender.get(platformUserId) ?? new Set();
		workspaces.add(workspace);
		workspacesBySender.set(platformUserId, workspaces);

		normalised.push({ platformUserId, alias, project, workspace, enabled });
	}

	for (const [sender, workspaces] of workspacesBySender) {
		if (workspaces.size > 1) {
			throw new Error(`sender '${sender}' resolves to more than one default workspace`);
		}
	}

	return normalised;
}
