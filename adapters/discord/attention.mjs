/**
 * Discord → core attention. Maps a Discord message onto handle-space tokens.
 * Instance registry (who is which Discord user) is passed in; this file stores
 * no ids. Core then matches tokens and plaintext.
 */
import { resolveAttention } from "../../core/attention.mjs";

/**
 * @param {object} message  Discord-like: { content?, mentions?: Array<{id}> }
 * @param {{participants: Array<{platformUserId:string, alias:string, project:string, handles?:string[]}>}} registry
 */
export function extractAddressTokens(message, { registry } = {}) {
	const list = registry?.participants;
	if (!Array.isArray(list)) throw new Error("registry.participants must be an array");
	const byId = new Map(list.map((entry) => [entry.platformUserId, entry]));
	const tokens = [];
	for (const mention of message?.mentions ?? []) {
		const id = typeof mention === "string" ? mention : mention?.id;
		const hit = byId.get(id);
		if (hit) tokens.push(hit.alias);
	}
	return {
		tokens,
		text: typeof message?.content === "string" ? message.content : "",
	};
}

/**
 * Resolve who a Discord message addressed, using the instance registry as the
 * attention roster. Does not start work.
 */
export function resolveDiscordAttention(message, { registry } = {}) {
	const { tokens, text } = extractAddressTokens(message, { registry });
	return resolveAttention({
		tokens,
		text,
		roster: {
			participants: (registry?.participants ?? []).map((entry) => ({
				alias: entry.alias,
				project: entry.project,
				handles: entry.handles,
			})),
		},
	});
}
