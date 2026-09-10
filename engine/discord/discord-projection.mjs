import { randomUUID } from "node:crypto";
import { formatOperatorStatus, postDiscordMessage } from "./discord-delivery.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function projectionRequestError(reasonCode) {
	return Object.assign(new Error(`Discord projection request ${reasonCode}`), { code: reasonCode });
}

async function boundedFetch(fetchImpl, url, init, { signal, timeoutMs }) {
	if (signal?.aborted) throw projectionRequestError("request_aborted");
	const controller = new AbortController();
	let rejectCancellation;
	const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
	const abort = () => {
		controller.abort(signal?.reason);
		rejectCancellation(projectionRequestError("request_aborted"));
	};
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		controller.abort("timeout");
		rejectCancellation(projectionRequestError("request_timeout"));
	}, timeoutMs);
	timer.unref?.();
	const request = Promise.resolve().then(() => fetchImpl(url, { ...init, signal: controller.signal }));
	request.catch(() => {});
	try {
		return await Promise.race([request, cancellation]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

export class DiscordStatusProjection {
	constructor({ store, token, botUserId, fetchImpl = fetch, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
		if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 60_000) throw new Error("Discord projection timeout is invalid");
		this.store = store;
		this.token = token;
		this.botUserId = botUserId;
		this.fetchImpl = fetchImpl;
		this.requestTimeoutMs = requestTimeoutMs;
	}

	async publishScope({ scopeKey, channelId, signal }) {
		const content = formatOperatorStatus(this.store.status(), this.store.listJobsForScope(scopeKey));
		const existing = this.store.loadDiscordProjection(scopeKey);
		if (existing?.channelId === channelId) {
			try {
				const response = await boundedFetch(this.fetchImpl, `${DISCORD_API}/channels/${channelId}/messages/${existing.messageId}`, { method: "PATCH", headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) }, { signal, timeoutMs: this.requestTimeoutMs });
				if (response.ok && !signal?.aborted) return { state: "updated", messageId: existing.messageId };
			} catch (error) {
				if (signal?.aborted || new Set(["request_aborted", "request_timeout"]).has(error?.code)) return { state: "unknown", reasonCode: error.code ?? "request_aborted" };
			}
		}
		if (signal?.aborted) return { state: "unknown", reasonCode: "request_aborted" };
		const nonce = randomUUID().replaceAll("-", "").slice(0, 24);
		const receipt = await postDiscordMessage({ token: this.token, channelId, content, nonce, botUserId: this.botUserId, fetchImpl: this.fetchImpl, signal, timeoutMs: this.requestTimeoutMs });
		if (receipt.state !== "confirmed") return receipt;
		if (signal?.aborted) return { state: "unknown", reasonCode: "request_aborted" };
		this.store.saveDiscordProjection({ scopeKey, channelId, messageId: receipt.messageId });
		if (!signal?.aborted) {
			try { await boundedFetch(this.fetchImpl, `${DISCORD_API}/channels/${channelId}/pins/${receipt.messageId}`, { method: "PUT", headers: { authorization: `Bot ${this.token}` } }, { signal, timeoutMs: this.requestTimeoutMs }); } catch {}
		}
		return { state: "created", messageId: receipt.messageId };
	}
}
