/**
 * Transport-neutral redaction.
 *
 * Text that leaves the engine towards a person or a log — a status line, an
 * event excerpt, a quoted summary — is scrubbed here before any adapter sees
 * it. The rules do not know about Discord; an adapter adds its own mention
 * handling on top (see adapters/discord).
 *
 * Extracted and genericised from the alpha-adk manage-discord-sessions helper
 * (helper/sanitize.mjs). Instance-specific enum tables were left in the
 * instance; only the reusable redaction and identity guards live here.
 */

const SECRET_PATTERNS = [
	// API keys with a recognised prefix (sk-, xox…, sk-or-v1-, …).
	/\b(?:sk|sk-or-v1|xox[baprs])-[-A-Za-z0-9_]{8,}\b/gi,
	// Bearer / bot authorization values.
	/\b(?:bot|bearer)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
	// key: value / key=value assignments naming a secret.
	/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,
	// Three-segment JWT-shaped credentials.
	/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
];

// Absolute filesystem paths reveal host layout and account names.
const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:\\|\/(?:home|Users|var\/home)\/)[^\s"']+/g;

const MAX_EVENT_EXCERPT_LENGTH = 480;

/** The longest a redacted single-line summary may be. */
export const MAX_SAFE_SUMMARY_LENGTH = 400;

function redactText(value) {
	let sanitized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	for (const pattern of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
	return sanitized.replace(LOCAL_PATH_PATTERN, "[LOCAL_PATH]");
}

/** Collapse to one line, strip secrets and local paths, and bound the length. */
export function sanitizeSummary(value) {
	if (typeof value !== "string") throw new TypeError("summary must be a string");
	const sanitized = redactText(value);
	if (sanitized.length > MAX_SAFE_SUMMARY_LENGTH) {
		throw new Error(`summary exceeds ${MAX_SAFE_SUMMARY_LENGTH} characters`);
	}
	return sanitized;
}

/** A bounded, redacted excerpt for event logs. Returns null for empty input. */
export function boundedSafeExcerpt(value) {
	if (typeof value !== "string") throw new TypeError("excerpt must be a string");
	const sanitized = redactText(value);
	if (!sanitized) return null;
	const characters = [...sanitized];
	const truncated = characters.length > MAX_EVENT_EXCERPT_LENGTH;
	return {
		excerpt: truncated
			? `${characters.slice(0, MAX_EVENT_EXCERPT_LENGTH - 1).join("")}…`
			: sanitized,
		truncated,
	};
}

/**
 * A safe short identifier: a bounded, character-restricted token that does not
 * itself resemble a secret. Used for job ids, profile ids, check ids.
 */
export function safeIdentifier(value, label = "identifier") {
	if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
		throw new Error(`${label} must be a safe identifier`);
	}
	if (sanitizeSummary(value) !== value) throw new Error(`${label} resembles sensitive data`);
	return value;
}

/** A canonical ISO-8601 timestamp string, round-tripped to reject drift. */
export function canonicalTimestamp(value, label = "timestamp") {
	if (typeof value !== "string") throw new TypeError(`${label} must be a canonical ISO timestamp`);
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new Error(`${label} must be a canonical ISO timestamp`);
	}
	return value;
}

/** Reject any object key outside an allow-set. */
export function assertOnlyKeys(value, allowed, label) {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
	}
}
