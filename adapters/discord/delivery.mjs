/**
 * Discord delivery — the Discord side of core's delivery-receipt contract.
 *
 * Core (core/delivery.mjs) splits sanitised content and drives idempotent
 * attempts; this module performs one HTTP attempt against the Discord API and
 * maps the response onto a core receipt: confirmed / failed / unknown.
 *
 * The API base below is Discord's public endpoint — it is not a secret and
 * carries no instance data. Real channel/user ids arrive as arguments at call
 * time from instance config and are never written into this repository.
 *
 * Extracted from the alpha-adk helper (helper/discord-delivery.mjs). The
 * store/receipt-persistence coupling was left in the instance; here the caller
 * owns persistence and passes the credential in.
 */
import { deliver } from "../../core/delivery.mjs";

const API_BASE = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{17,20}$/;

function snowflake(value, label) {
	if (typeof value !== "string" || !SNOWFLAKE.test(value)) throw new Error(`${label} must be a Discord snowflake`);
	return value;
}

/**
 * Post one message and return a core delivery receipt.
 * @returns {Promise<{state:"confirmed"|"failed"|"unknown", messageId?:string, reasonCode?:string, status:number|null}>}
 */
export async function postDiscordMessageOnce({
	token,
	channelId,
	content,
	nonce,
	botUserId,
	fetchImpl = fetch,
	signal,
	timeoutMs = 15000,
	allowedUsers = [],
}) {
	snowflake(channelId, "channelId");
	if (typeof token !== "string" || token.length < 16) throw new Error("Discord credential is not ready");
	if (typeof content !== "string" || content.length === 0 || content.length > 2000) {
		throw new Error("Discord message length is invalid");
	}
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error("Discord request timeout is invalid");
	if (!Array.isArray(allowedUsers) || allowedUsers.length > 100 || allowedUsers.some(id => typeof id !== "string" || !SNOWFLAKE.test(id))) throw new Error("Discord allowed users are invalid");
	if (typeof nonce !== "string" || !/^[A-Za-z0-9_:-]{1,25}$/.test(nonce)) throw new Error("Discord delivery nonce is invalid");
	// The host supplies registered recipients, and only direct first-line calls
	// can notify them. Quoted calls and later body mentions have no calling power.
	const firstLine = content.split(/\r?\n/, 1)[0];
	const addressed = firstLine.trimStart().startsWith(">") ? [] : [...firstLine.matchAll(/<@!?(\d{17,20})>/g)].map(match => match[1]);
	const users = [...new Set(allowedUsers.filter(id => addressed.includes(id)))];
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(abort, timeoutMs);
	timeout.unref?.();
	try {
		const response = await fetchImpl(`${API_BASE}/channels/${channelId}/messages`, {
			method: "POST",
			headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ content, allowed_mentions: { parse: [], ...(users.length ? { users } : {}), replied_user: false }, nonce, enforce_nonce: true }),
			signal: controller.signal,
		});
		if (response.ok) {
			const body = await response.json();
			// A returned message is an authoritative receipt only when its channel
			// and bot author match; a present nonce must match exactly.
			if (
				body.channel_id !== channelId ||
				(botUserId && body.author?.id !== botUserId) ||
				(body.nonce !== undefined && String(body.nonce) !== nonce)
			) {
				return { state: "unknown", reasonCode: "receipt_identity_mismatch", status: response.status };
			}
			return { state: "confirmed", messageId: snowflake(String(body.id), "messageId"), status: response.status };
		}
		if (response.status >= 400 && response.status < 500) {
			const reasonCode = response.status === 401 || response.status === 403 ? "authorization" : "request_rejected";
			return { state: "failed", reasonCode, status: response.status };
		}
		return { state: "unknown", reasonCode: "server_response_unknown", status: response.status };
	} catch {
		return { state: "unknown", reasonCode: "network_result_unknown", status: null };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

/**
 * Deliver a full (already sanitised) response to a Discord channel, splitting
 * and driving idempotent attempts through core.
 */
export function deliverToDiscord({ token, channelId, content, botUserId, fetchImpl = fetch, signal, nonce }) {
	return deliver({
		content,
		nonce,
		limits: { maxChars: 900, maxBytes: 1500 },
		postOnce: (chunk, chunkNonce) =>
			postDiscordMessageOnce({ token, channelId, content: chunk, nonce: chunkNonce, botUserId, fetchImpl, signal }),
	});
}
