/**
 * Attention — who a message addressed, transport-neutral.
 *
 * The adapter extracts opaque tokens (handles, aliases) and optional plaintext.
 * Core matches those against a roster the instance supplies. Core does not
 * start a process, open a round, or know Discord. Waking a local worker is
 * the host's job; this module only answers "was this participant named?".
 *
 * Posted ≠ received ≠ started still holds (see verdict.mjs). An attention
 * match is not a start receipt.
 */
import { formatIdentity } from "./identity.mjs";

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/;

/**
 * Validate a roster used for address matching.
 * `handles` are extra names the instance uses in speech (device names, short
 * callsigns). They must be unique across the roster. `alias` is also a handle.
 *
 * @param {{participants: Array<{alias:string, project:string, handles?:string[]}>}} roster
 */
export function validateAttentionRoster(roster) {
	const list = roster?.participants;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error("attention roster.participants must be a non-empty array");
	}
	const seen = new Map(); // handle -> identity
	const normalised = [];
	for (const [index, entry] of list.entries()) {
		if (!entry || typeof entry !== "object") throw new Error(`attention participant ${index} must be an object`);
		const identity = formatIdentity({ alias: entry.alias, project: entry.project });
		const handles = new Set([String(entry.alias).toLowerCase()]);
		const extra = entry.handles ?? [];
		if (!Array.isArray(extra)) throw new Error(`attention participant ${index}: handles must be an array`);
		for (const raw of extra) {
			const handle = String(raw ?? "").trim().toLowerCase();
			if (!HANDLE_PATTERN.test(handle)) {
				throw new Error(`attention participant ${index}: handle is not a valid name`);
			}
			handles.add(handle);
		}
		for (const handle of handles) {
			if (seen.has(handle)) {
				throw new Error(`handle '${handle}' is claimed by both ${seen.get(handle)} and ${identity}`);
			}
			seen.set(handle, identity);
		}
		normalised.push({
			alias: entry.alias,
			project: entry.project,
			identity,
			handles: [...handles].sort(),
		});
	}
	return normalised;
}

function tokenKey(value) {
	return String(value ?? "").trim().toLowerCase();
}

/**
 * Match explicit tokens (already in handle space) against the roster.
 * Tokens that hit nobody are returned in `unmatched`.
 */
export function matchAddressedParticipants({ tokens, roster }) {
	const participants = Array.isArray(roster) ? roster : validateAttentionRoster(roster);
	const byHandle = new Map();
	for (const participant of participants) {
		for (const handle of participant.handles) byHandle.set(handle, participant);
	}
	const addressed = [];
	const seenIdentity = new Set();
	const unmatched = [];
	for (const raw of tokens ?? []) {
		const key = tokenKey(raw);
		if (!key) continue;
		const hit = byHandle.get(key);
		if (!hit) {
			unmatched.push(String(raw).trim());
			continue;
		}
		if (seenIdentity.has(hit.identity)) continue;
		seenIdentity.add(hit.identity);
		addressed.push(hit);
	}
	return { addressed, unmatched };
}

/**
 * Scan plaintext for roster handles as whole tokens (letter/digit/_/.-).
 * This is how "4060, take the GPU path" addresses a device without a platform
 * mention. Short handles under 3 characters are ignored in plaintext to avoid
 * matching noise.
 */
export function scanPlaintextHandles({ text, roster }) {
	const participants = Array.isArray(roster) ? roster : validateAttentionRoster(roster);
	const body = String(text ?? "");
	if (!body) return { addressed: [], unmatched: [] };
	const tokens = [];
	const seen = new Set();
	for (const participant of participants) {
		for (const handle of participant.handles) {
			if (handle.length < 3) continue;
			if (seen.has(handle)) continue;
			const pattern = new RegExp(`(^|[^a-z0-9_.-])${escapeRegExp(handle)}([^a-z0-9_.-]|$)`, "i");
			if (pattern.test(body)) {
				tokens.push(handle);
				seen.add(handle);
			}
		}
	}
	return matchAddressedParticipants({ tokens, roster: participants });
}

/**
 * Combine adapter tokens and plaintext scan. Duplicate identities collapse.
 */
export function resolveAttention({ tokens = [], text = "", roster }) {
	const participants = validateAttentionRoster(roster);
	const fromTokens = matchAddressedParticipants({ tokens, roster: participants });
	const fromText = scanPlaintextHandles({ text, roster: participants });
	const addressed = [];
	const seen = new Set();
	for (const hit of [...fromTokens.addressed, ...fromText.addressed]) {
		if (seen.has(hit.identity)) continue;
		seen.add(hit.identity);
		addressed.push(hit);
	}
	return {
		addressed,
		unmatched: fromTokens.unmatched,
		named: addressed.length > 0,
	};
}

/**
 * Filter attention down to identities this host is responsible for.
 * Starting a worker remains the host's job.
 *
 * @returns {{wake: Array, named: boolean}}
 */
export function localAttention({ attention, localIdentities }) {
	if (!attention || !Array.isArray(attention.addressed)) {
		throw new Error("attention.addressed is required");
	}
	if (!Array.isArray(localIdentities) || localIdentities.length === 0) {
		throw new Error("localIdentities must be a non-empty array");
	}
	const wanted = new Set(localIdentities.map((id) => String(id).trim()).filter(Boolean));
	const wake = attention.addressed.filter((hit) => wanted.has(hit.identity) || wanted.has(hit.alias));
	return { wake, named: wake.length > 0 };
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
