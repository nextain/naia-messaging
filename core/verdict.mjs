/**
 * Acknowledgement and response verdict — transport-neutral.
 *
 * Three states are deliberately kept apart, because collapsing any two of them
 * hides the worst failures:
 *   - posted   : a message left the engine (see core/delivery.mjs).
 *   - received : the platform accepted it.
 *   - started  : the work actually began.
 *
 * A bare "[message received]" acknowledgement is a START RECEIPT, not a
 * response. If the engine treats an ack as if it had answered, a request can
 * be "received" and then silently dropped — the exact failure this module
 * exists to catch.
 *
 * `whoseTurn` answers: after the last human utterance, did the engine post a
 * REAL reply (something past a mere ack)? If not, it is our turn.
 *
 * Genericised from a server-profile instance's our-turn verdict script; the
 * host and guild specifics were left in that instance.
 */

/** The canonical bare acknowledgement text. Matching is done case-insensitively. */
export const ACK_MARKERS = ["[message received]", "[메시지 받음]"];

function isBareAck(text) {
	const body = String(text ?? "").trim().toLowerCase();
	if (!body) return false;
	return ACK_MARKERS.some((marker) => body === marker.toLowerCase());
}

/**
 * Given a conversation ordered newest-first, decide whose turn it is.
 *
 * @param {Array<{authorIsAgent:boolean, text?:string, timestamp?:string, author?:string}>} messages
 *        newest-first. `authorIsAgent` is set by the caller/adapter.
 * @param {() => number} [nowMs]
 * @returns {{whoseTurn:"agent"|"human"|"idle", waitingMinutes?:number, author?:string, summary?:string}}
 */
export function whoseTurn(messages, nowMs = () => Date.now()) {
	if (!Array.isArray(messages) || messages.length === 0) return { whoseTurn: "idle" };

	let humanIndex = -1;
	for (let i = 0; i < messages.length; i += 1) {
		if (!messages[i]?.authorIsAgent) {
			humanIndex = i;
			break;
		}
	}
	if (humanIndex === -1) return { whoseTurn: "idle" }; // no human utterance to answer

	// Everything newer than the last human message is an agent message. If any
	// of those is a real reply (not a bare ack), we already answered.
	for (let i = 0; i < humanIndex; i += 1) {
		if (!messages[i]?.authorIsAgent) continue;
		const body = String(messages[i]?.text ?? "").trim();
		if (body && !isBareAck(body)) return { whoseTurn: "human" }; // answered
	}

	const human = messages[humanIndex];
	const summary = String(human.text ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 160);
	let waitingMinutes;
	if (human.timestamp) {
		const stamp = Date.parse(human.timestamp);
		if (Number.isFinite(stamp)) waitingMinutes = Math.floor((nowMs() - stamp) / 60000);
	}
	return { whoseTurn: "agent", waitingMinutes, author: human.author, summary };
}

/**
 * Classify a single agent-authored message as a start receipt or a substantive
 * response. Delivery success plus this classification is what lets a monitor
 * distinguish "acknowledged but never started" from "answered".
 */
export function classifyAgentMessage(text) {
	const body = String(text ?? "").trim();
	if (!body) return "empty";
	return isBareAck(body) ? "start_receipt" : "response";
}
