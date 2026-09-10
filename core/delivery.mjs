/**
 * Delivery receipt — transport-neutral.
 *
 * Delivery has three outcomes and they must not be collapsed:
 *   - confirmed : the transport returned an authoritative receipt.
 *   - failed    : the transport rejected it for a reason that will not fix
 *                 itself (authorization, a malformed request).
 *   - unknown   : we do not know — a timeout, a network drop, an ambiguous
 *                 response. This is NOT success and NOT failure; it needs
 *                 review, and a resend must be idempotent (see nonce below).
 *
 * A per-delivery nonce lets an adapter make sends idempotent: the same nonce
 * must never produce two posted messages, so an "unknown" outcome can be
 * retried without doubling up.
 *
 * Adapters (core has no network of its own) implement `postOnce` against their
 * transport and return one of these outcomes; `deliver` splits long content,
 * drives the attempts, and records receipts.
 */
import { randomUUID } from "node:crypto";

export const DELIVERY_STATES = new Set(["confirmed", "failed", "unknown"]);

/** A fresh 24-char delivery nonce with no separators. */
export function newDeliveryNonce() {
	return randomUUID().replaceAll("-", "").slice(0, 24);
}

/** Derive a per-chunk nonce so multi-part delivery stays idempotent. */
export function chunkNonce(nonce, index) {
	if (index === 0) return nonce;
	return `${nonce.slice(0, 19)}${String(index + 1).padStart(5, "0")}`;
}

/**
 * Split content into transport-sized chunks and prefix multi-part sends with
 * `(i/n)`. `maxChars` / `maxBytes` are transport limits an adapter supplies.
 */
export function splitContent(content, { maxChars = 900, maxBytes = 1500 } = {}) {
	const chunks = [];
	let current = "";
	for (const character of content) {
		const candidate = current + character;
		if (current && (candidate.length > maxChars || Buffer.byteLength(candidate, "utf8") > maxBytes)) {
			chunks.push(current);
			current = character;
		} else current = candidate;
	}
	if (current) chunks.push(current);
	if (chunks.length <= 1) return chunks;
	return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}

/**
 * Drive delivery of already-sanitised content through an adapter's `postOnce`.
 *
 * @param {object} args
 * @param {string} args.content   caller must have run this through core/redact first
 * @param {(chunk:string, chunkNonce:string) => Promise<{state:string, messageId?:string, reasonCode?:string}>} args.postOnce
 * @param {object} [args.limits]  { maxChars, maxBytes }
 * @param {string} [args.nonce]
 * @returns {Promise<{state:"confirmed"|"failed"|"unknown", receipts:Array}>}
 */
export async function deliver({ content, postOnce, limits, nonce = newDeliveryNonce() }) {
	if (typeof content !== "string" || content.length === 0) throw new Error("delivery content must be a non-empty string");
	if (typeof postOnce !== "function") throw new Error("postOnce adapter is required");
	const chunks = splitContent(content, limits);
	const receipts = [];
	for (let index = 0; index < chunks.length; index += 1) {
		const receipt = await postOnce(chunks[index], chunkNonce(nonce, index));
		if (!receipt || !DELIVERY_STATES.has(receipt.state)) {
			throw new Error("postOnce must return a receipt with a known delivery state");
		}
		receipts.push(receipt);
		if (receipt.state !== "confirmed") return { state: receipt.state, receipts };
	}
	return { state: "confirmed", receipts };
}
