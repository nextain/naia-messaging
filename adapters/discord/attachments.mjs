/**
 * Discord attachments — describing what a message carries so the engine can
 * fetch it.
 *
 * The engine long copied only `message.content` into a prompt. A message that
 * arrived with a file looked empty, and a file-only message was dropped for
 * having no body. This surfaces two lines per attachment — what is attached and
 * how to fetch it — so the engine can act on it instead of silently ignoring it.
 *
 * Extracted from the alpha-adk helper (helper/discord-attachments.mjs) and
 * decoupled from that skill's CLI path: the fetch instruction is supplied by
 * the runtime rather than hard-coded here.
 */
import { sanitizeSummary } from "../../core/redact.mjs";

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_LISTED_ATTACHMENTS = 10;
const MAX_FILENAME_LENGTH = 120;

/** Flatten a filename to a safe basename, or null if nothing usable remains. */
export function safeAttachmentName(value) {
	const raw = typeof value === "string" ? value : "";
	const flattened = raw
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replaceAll("\\", "/")
		.split("/")
		.pop() ?? "";
	const trimmed = flattened.replace(/^\.+/, "").trim().slice(0, MAX_FILENAME_LENGTH);
	if (!trimmed) return null;
	try {
		return sanitizeSummary(trimmed) || null;
	} catch {
		return null;
	}
}

/** Keep only attachments the fetch path could actually resolve. */
export function describeDiscordAttachments(message) {
	const raw = Array.isArray(message?.attachments) ? message.attachments : [];
	const attachments = [];
	for (const item of raw) {
		if (attachments.length >= MAX_LISTED_ATTACHMENTS) break;
		if (!item || typeof item !== "object") continue;
		const attachmentId = String(item.id ?? "");
		if (!SNOWFLAKE.test(attachmentId) || /^0+$/.test(attachmentId)) continue;
		const filename = safeAttachmentName(item.filename) ?? `attachment-${attachmentId}`;
		const size = Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null;
		let contentType = null;
		if (typeof item.content_type === "string" && item.content_type) {
			try {
				contentType = sanitizeSummary(item.content_type.slice(0, 80)) || null;
			} catch {
				contentType = null;
			}
		}
		attachments.push({ attachmentId, filename, size, contentType });
	}
	return { attachments, omitted: Math.max(0, raw.length - attachments.length) };
}

/** A short marker for a history line; the body may be empty but the file is noted. */
export function attachmentSummaryText(message) {
	const { attachments, omitted } = describeDiscordAttachments(message);
	if (attachments.length === 0) return "";
	const names = attachments.map((item) => item.filename).join(", ");
	return omitted > 0 ? `[attached: ${names} (+${omitted} more)]` : `[attached: ${names}]`;
}

/**
 * A prompt block that lists the files and how to fetch them. The concrete
 * fetch instruction is supplied by the runtime (`fetchInstruction(item)`),
 * because how a file is downloaded is an instance/runtime detail, not core.
 */
export function attachmentPromptSection(message, { fetchInstruction } = {}) {
	const { attachments, omitted } = describeDiscordAttachments(message);
	if (attachments.length === 0) return "";
	const lines = ["Attached files:"];
	for (const item of attachments) {
		const size = item.size === null ? "unknown size" : `${item.size} bytes`;
		const type = item.contentType ? `, ${item.contentType}` : "";
		lines.push(`- ${item.filename} (${size}${type}) attachmentId=${item.attachmentId}`);
	}
	if (omitted > 0) lines.push(`- (${omitted} more attachment(s) were not listed)`);
	lines.push("These files are not readable until you download them.");
	if (typeof fetchInstruction === "function") {
		for (const item of attachments) {
			const line = fetchInstruction(item);
			if (line) lines.push(`  ${line}`);
		}
	}
	lines.push("Download into a working directory, read the file, then answer. Never claim a file is unreadable without attempting the download first.");
	return lines.join("\n");
}
