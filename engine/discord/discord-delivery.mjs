import { sanitizeFinalResponse } from "./sanitize.mjs";
import { randomUUID } from "node:crypto";
import { splitContent, chunkNonce } from "../../core/delivery.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_DELIVERY_CHUNK_CHARS = 900;
const MAX_DELIVERY_CHUNK_BYTES = 1_500;

function snowflake(value, label) {
	if (typeof value !== "string" || !/^\d{17,20}$/.test(value)) throw new Error(`${label} must be a Discord snowflake`);
	return value;
}

// The adapter owns the single HTTP attempt. Unknown outcomes are never replayed.
export { postDiscordMessageOnce as postDiscordMessage } from "../../adapters/discord/delivery.mjs";
import { postDiscordMessageOnce as postDiscordMessage } from "../../adapters/discord/delivery.mjs";

export async function postDiscordDirectMessage({ token, userId, content, nonce, botUserId, fetchImpl = fetch, signal, timeoutMs = 15_000 }) {
	snowflake(userId, "userId");
	if (typeof token !== "string" || token.length < 16) throw new Error("Discord credential is not ready");
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(abort, timeoutMs);
	timeout.unref?.();
	try {
		const response = await fetchImpl(`${DISCORD_API}/users/@me/channels`, { method: "POST", headers: { authorization: `Bot ${token}`, "content-type": "application/json" }, body: JSON.stringify({ recipient_id: userId }), signal: controller.signal });
		if (!response.ok) return response.status >= 400 && response.status < 500 ? { state: "failed", reasonCode: response.status === 401 || response.status === 403 ? "authorization" : "request_rejected", status: response.status } : { state: "unknown", reasonCode: "server_response_unknown", status: response.status };
		const body = await response.json();
		const channelId = snowflake(body.id, "channelId");
		return postDiscordMessage({ token, channelId, content, nonce, botUserId, fetchImpl, signal, timeoutMs });
	} catch {
		return { state: "unknown", reasonCode: "network_result_unknown", status: null };
	} finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

export function splitDiscordContent(content) {
 return splitContent(content, { maxChars: MAX_DELIVERY_CHUNK_CHARS, maxBytes: MAX_DELIVERY_CHUNK_BYTES });
}

export async function deliverJobResult({ store, jobId, attemptId, token, channelId, botUserId, content, fetchImpl = fetch, signal, now = () => new Date().toISOString() }) {
	const safeContent = sanitizeFinalResponse(content);
	const chunks = splitDiscordContent(safeContent);
	const candidateNonce = randomUUID().replaceAll("-", "").slice(0, 24);
	const reserved = store.reserveDelivery({ deliveryKey: `delivery:${candidateNonce}`, jobId, attemptId, nonce: candidateNonce, channelId, now: now() });
	if (reserved.status !== "started" || reserved.existing) return { state: reserved.status === "confirmed" ? "confirmed" : "unknown", receipts: [] };
	const { deliveryKey, nonce } = reserved;
	const receipts = [];
	for (let index = 0; index < chunks.length; index += 1) {
		const receipt = await postDiscordMessage({ token, channelId, content: chunks[index], nonce: chunkNonce(nonce, index), botUserId, fetchImpl, signal });
		receipts.push(receipt);
		if (receipt.state !== "confirmed") {
			store.finishDelivery({
				deliveryKey,
				status: receipt.state,
				reasonCode: receipt.state === "unknown"
					? receipt.reasonCode
					: receipt.reasonCode === "authorization" ? "authorization" : "internal_error",
				now: now(),
			});
			return { state: receipt.state, receipts };
		}
	}
	try {
		store.finishDelivery({ deliveryKey, status: "confirmed", messageId: receipts.at(-1).messageId, now: now() });
	} catch {
		try { store.finishDelivery({ deliveryKey, status: "unknown", reasonCode: "delivery_commit_unknown", now: now() }); } catch {}
		return { state: "unknown", receipts };
	}
	return { state: "confirmed", receipts };
}

export function formatOperatorStatus(status, jobs) {
	const service = status.service;
	const active = jobs.filter((job) => !["completed", "failed", "cancelled", "recovery_review"].includes(job.lifecycle));
	const stalled = jobs.filter((job) => job.activityHealth.value === "suspected_stalled").length;
	const review = jobs.filter((job) => job.lifecycle === "recovery_review").length;
	const deliveryIssues = jobs.filter((job) => new Set(["unknown", "failed"]).has(job.deliveryState)).length;
	const lines = [
		`Naia Discord service: ${service.state} (${service.reasonCode})`,
		`Current work ${active.length} · stalled ${stalled} · delivery issues ${deliveryIssues}`,
		"Foreign collaboration agent supervision: unsupported",
	];
	if (review > 0) lines.push(`Historical unresolved ${review} (not queued)`);
	for (const job of active.slice(0, 8)) lines.push(`${job.jobId}: ${job.lifecycle} / ${job.activityHealth.value} / ${job.currentActivity ?? job.safeSummary}`);
	return lines.join("\n").slice(0, 2_000);
}
