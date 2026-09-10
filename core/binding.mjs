/**
 * Thread ↔ work-item binding and attention routing — transport-neutral.
 *
 * A conversation SCOPE is where a message happened, abstracted from any one
 * platform: a direct message, a shared channel, or a thread inside a channel.
 * A BINDING is the durable rule that ties a scope to an agent profile and a
 * set of allowed participants, and (for threads) to a work item. Core does not
 * know a Discord snowflake from a future messenger's id — it only compares
 * opaque string ids that an adapter fills in.
 *
 * Genericised from the alpha-adk helper (helper/discord-scope.mjs). The
 * Discord-specific classification of a raw message into a scope lives in
 * adapters/discord/scope.mjs; the rules below are shared by every adapter.
 */
import { createHash } from "node:crypto";
import { assertOnlyKeys, safeIdentifier } from "./redact.mjs";

export const SCOPE_KINDS = new Set(["dm", "channel", "thread"]);
export const RESPOND_WHEN = new Set(["mentioned", "always"]);
export const HISTORY_VISIBILITY = new Set(["none", "requester_only", "shared"]);

/**
 * A stable, non-reversible key for a scope. Two messages in the same place
 * hash to the same key; the raw ids are not recoverable from it, so the key is
 * safe to log.
 */
export function scopeKey(scope) {
	return createHash("sha256")
		.update(`${scope.kind}\0${scope.spaceId ?? ""}\0${scope.channelId}\0${scope.threadId ?? ""}`)
		.digest("hex")
		.slice(0, 24);
}

function bindingMatches(binding, scope) {
	if (binding.kind !== scope.kind) return false;
	if (binding.spaceId && binding.spaceId !== scope.spaceId) return false;
	if (binding.channelId && binding.channelId !== scope.channelId) return false;
	if (binding.threadId && binding.threadId !== scope.threadId) return false;
	if (binding.userId && binding.userId !== scope.authorId) return false;
	return true;
}

/**
 * Decide whether the engine may act on a message in a scope, and whether the
 * author is an operator.
 *
 * Attention routing rule: `respondWhen: "mentioned"` (the default) means the
 * engine stays silent in a shared space until it is addressed. This is how bot
 * chatter is kept from landing on an owner who did not ask for it — a work item
 * only reaches a person through an explicit mention or a binding that names
 * them.
 *
 * @param {object} args
 * @param {object} args.scope       already classified by an adapter
 * @param {Array}  args.bindings    validated bindings
 * @param {boolean} args.isMentioned whether the engine was addressed (adapter decides)
 * @param {boolean} args.isAutomated whether the sender is a bot/webhook (adapter decides)
 * @param {string[]} [args.operatorUserIds]
 * @param {object|null} [args.participantProfiles] map platformUserId -> profile
 */
export function authorize({
	scope,
	bindings,
	isMentioned,
	isAutomated,
	operatorUserIds = [],
	participantProfiles = null,
}) {
	if (isAutomated) return { allowed: false, reasonCode: "automated_sender" };
	const key = scopeKey(scope);
	const binding = bindings.find((candidate) => bindingMatches(candidate, scope));
	if (!binding) return { allowed: false, reasonCode: "binding_missing", scope, scopeKey: key };
	if (!binding.allowedUserIds?.includes(scope.authorId)) {
		return { allowed: false, reasonCode: "user_not_allowed", scope, scopeKey: key };
	}
	if ((binding.respondWhen ?? "mentioned") === "mentioned" && !isMentioned) {
		return { allowed: false, reasonCode: "mention_required", scope, scopeKey: key };
	}
	const participantProfile = participantProfiles ? participantProfiles[scope.authorId] ?? null : null;
	if (participantProfiles && !participantProfile) {
		return { allowed: false, reasonCode: "participant_profile_missing", scope, scopeKey: key };
	}
	return {
		allowed: true,
		reasonCode: "authorized",
		scope,
		scopeKey: key,
		isOperator: operatorUserIds.includes(scope.authorId) && binding.operatorActions === true,
		participantProfile,
		binding,
	};
}

const BINDING_KEYS = new Set([
	"kind",
	"spaceId",
	"channelId",
	"threadId",
	"userId",
	"agentProfileId",
	"workItem",
	"respondWhen",
	"allowedUserIds",
	"canStartConversation",
	"operatorActions",
	"historyVisibility",
]);

/**
 * Validate a list of bindings, returning them normalised with defaults.
 * `workItem` is the transport-neutral form of the thread↔issue tie: an opaque
 * `<repo>#<number>`-shaped reference an adapter and instance agree on.
 */
export function validateBindings(bindings, { canRespondAlways = false } = {}) {
	if (!Array.isArray(bindings) || bindings.length === 0) {
		throw new Error("at least one binding is required");
	}
	return bindings.map((binding) => {
		assertOnlyKeys(binding, BINDING_KEYS, "binding");
		if (!SCOPE_KINDS.has(binding.kind)) throw new Error("unsupported binding kind");
		for (const key of ["spaceId", "channelId", "threadId", "userId"]) {
			if (binding[key] !== undefined && (typeof binding[key] !== "string" || binding[key].length === 0)) {
				throw new Error(`${key} must be a non-empty id string`);
			}
		}
		if (binding.agentProfileId !== undefined) safeIdentifier(binding.agentProfileId, "agentProfileId");
		if (binding.workItem !== undefined && !/^[^#\s]+#\d+$/.test(binding.workItem)) {
			throw new Error("workItem must look like <repo>#<number>");
		}
		if (!Array.isArray(binding.allowedUserIds) || binding.allowedUserIds.length === 0) {
			throw new Error("binding allowedUserIds is required");
		}
		const respondWhen = binding.respondWhen ?? "mentioned";
		if (!RESPOND_WHEN.has(respondWhen)) throw new Error("unsupported respondWhen policy");
		if (binding.kind !== "dm" && respondWhen === "always" && !canRespondAlways) {
			throw new Error("always-respond in a shared space requires the message-content capability");
		}
		if (binding.canStartConversation !== undefined && typeof binding.canStartConversation !== "boolean") {
			throw new Error("canStartConversation must be boolean");
		}
		if (binding.operatorActions !== undefined && typeof binding.operatorActions !== "boolean") {
			throw new Error("operatorActions must be boolean");
		}
		const historyVisibility = binding.historyVisibility ?? "shared";
		if (!HISTORY_VISIBILITY.has(historyVisibility)) throw new Error("unsupported historyVisibility policy");
		if (binding.kind === "dm" && !binding.userId && !binding.channelId) {
			throw new Error("dm binding requires userId or channelId");
		}
		if (binding.kind === "channel" && (!binding.spaceId || !binding.channelId)) {
			throw new Error("channel binding requires spaceId and channelId");
		}
		if (binding.kind === "thread" && (!binding.spaceId || !binding.channelId || !binding.threadId)) {
			throw new Error("thread binding requires spaceId, parent channelId, and threadId");
		}
		if (binding.kind !== "thread" && binding.threadId) {
			throw new Error("threadId is only valid for a thread binding");
		}
		return {
			...binding,
			respondWhen,
			historyVisibility,
			canStartConversation: binding.canStartConversation ?? false,
		};
	});
}
