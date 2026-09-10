// Compatibility vocabulary only; policy and classification live in core/adapter.
import { scopeKey, validateBindings } from "../../core/binding.mjs";
import { classifyDiscordScope, authorizeDiscordMessage as authorizeShared } from "../../adapters/discord/scope.mjs";
import { assertOnlyKeys, safeIdentifier } from "./sanitize.mjs";

function neutral(value) {
 const { guildId, ...rest } = value;
 return { ...rest, kind: value.kind === "guild_channel" ? "channel" : value.kind, ...(guildId === undefined ? {} : { spaceId: guildId }) };
}
function legacy(value) {
 const { spaceId, ...rest } = value;
 return { ...rest, kind: value.kind === "channel" ? "guild_channel" : value.kind, ...(spaceId === undefined ? {} : { guildId: spaceId }) };
}

function snowflake(value, label) {
	if (typeof value !== "string" || !/^\d{17,20}$/.test(value) || /^0+$/.test(value)) throw new Error(`${label} must be a Discord snowflake`);
	return value;
}

export function classifyDiscordConversation(message, threadParents = new Map()) {
 return legacy(classifyDiscordScope(message, threadParents));
}

// Preserve existing durable keys while the public adapter uses neutral names.
export function discordScopeKey(scope) {
 return scopeKey({ ...scope, spaceId: scope.guildId });
}

export function participantProfileForUser(participantProfiles, userId) {
	if (!participantProfiles) return null;
	const profile = participantProfiles[userId];
	if (!profile) return null;
	return {
		label: profile.label,
		relationship: profile.relationship,
		allowedActions: [...profile.allowedActions],
		...(profile.mutationWindow === undefined
			? {}
			: { mutationWindow: { ...profile.mutationWindow, days: [...profile.mutationWindow.days] } }),
	};
}

export function authorizeDiscordMessage(options) {
 const result = authorizeShared({ ...options, bindings: options.bindings.map(neutral) });
 if (!result.scope) return result;
 const scope = legacy(result.scope);
 const bindingIndex = result.binding ? options.bindings.findIndex(item => item.kind === scope.kind && (!item.guildId || item.guildId === scope.guildId) && (!item.channelId || item.channelId === scope.channelId) && (!item.threadId || item.threadId === scope.threadId) && (!item.userId || item.userId === scope.authorId)) : -1;
 return { ...result, scope, scopeKey: discordScopeKey(scope), ...(bindingIndex < 0 ? {} : { binding: options.bindings[bindingIndex] }), ...(result.allowed ? { participantProfile: participantProfileForUser(options.participantProfiles, scope.authorId) } : {}) };
}

export function validateDiscordBindings(bindings, { messageContentIntent = false, schemaVersion = 1 } = {}) {
	if (!Array.isArray(bindings) || bindings.length === 0) throw new Error("at least one Discord binding is required");
	return bindings.map((binding) => {
		assertOnlyKeys(binding, new Set(["kind", "guildId", "channelId", "threadId", "userId", "agentProfileId", "respondWhen", "allowedUserIds", "canStartConversation", "operatorActions", "historyVisibility"]), "Discord binding");
		if (!new Set(["dm", "guild_channel", "thread"]).has(binding.kind)) throw new Error("unsupported Discord binding kind");
		for (const [key, value] of Object.entries(binding)) {
			if (new Set(["guildId", "channelId", "threadId", "userId"]).has(key) && value !== undefined) snowflake(value, key);
		}
		if (binding.agentProfileId !== undefined) safeIdentifier(binding.agentProfileId, "agentProfileId");
		if (!Array.isArray(binding.allowedUserIds) || binding.allowedUserIds.length === 0) throw new Error("binding allowedUserIds is required");
		binding.allowedUserIds.forEach((value) => snowflake(value, "allowedUserId"));
		if (!new Set(["mentioned", "always"]).has(binding.respondWhen ?? "mentioned")) throw new Error("unsupported respondWhen policy");
		if (binding.kind !== "dm" && binding.respondWhen === "always" && !messageContentIntent) throw new Error("guild and thread always responses require messageContentIntent");
		if (binding.canStartConversation !== true && binding.canStartConversation !== false) throw new Error("canStartConversation must be boolean");
		if (binding.operatorActions !== undefined && typeof binding.operatorActions !== "boolean") throw new Error("operatorActions must be boolean");
		if (schemaVersion === 2 && !new Set(["none", "requester_only", "shared"]).has(binding.historyVisibility)) throw new Error("schema v2 binding historyVisibility must be explicit");
		if (schemaVersion === 1 && binding.historyVisibility !== undefined && !new Set(["none", "requester_only", "shared"]).has(binding.historyVisibility)) throw new Error("unsupported historyVisibility policy");
		if (binding.kind === "dm" && !binding.userId && !binding.channelId) throw new Error("DM binding requires userId or channelId");
		if (binding.kind === "guild_channel" && (!binding.guildId || !binding.channelId)) throw new Error("guild channel binding requires guildId and channelId");
		if (binding.kind === "thread" && (!binding.guildId || !binding.channelId || !binding.threadId)) throw new Error("thread binding requires guildId, parent channelId, and threadId");
		if (binding.kind !== "thread" && binding.threadId) throw new Error("threadId is only valid for a thread binding");
		validateBindings([neutral(binding)], { canRespondAlways: messageContentIntent });
		return { historyVisibility: binding.historyVisibility ?? "shared", ...binding };
	});
}
