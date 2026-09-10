/**
 * Discord scope classification — the Discord side of core's binding contract.
 *
 * This is where a raw Discord message becomes a transport-neutral scope that
 * core/binding can reason about. Everything Discord-specific — snowflake ids,
 * guilds, the mentions array — lives here; core never sees it.
 *
 * Genericised from the alpha-adk helper (helper/discord-scope.mjs). No real
 * ids ship: the snowflake check is a shape test, and callers pass their own
 * bot id and thread-parent map from instance config.
 */
import { authorize } from "../../core/binding.mjs";

const SNOWFLAKE = /^\d{17,20}$/;

function snowflake(value, label) {
	if (typeof value !== "string" || !SNOWFLAKE.test(value) || /^0+$/.test(value)) {
		throw new Error(`${label} must be a Discord snowflake`);
	}
	return value;
}

/**
 * Classify a Discord message into a neutral scope.
 * @param {object} message                    raw Discord message object
 * @param {Map<string,{parentChannelId:string}>} [threadParents]
 * @returns {{kind:"dm"|"channel"|"thread", spaceId?:string, channelId:string, threadId?:string, authorId:string}}
 */
export function classifyDiscordScope(message, threadParents = new Map()) {
	const channelId = snowflake(message.channel_id, "channelId");
	const authorId = snowflake(message.author?.id, "authorId");
	if (!message.guild_id) return { kind: "dm", channelId, authorId };
	const spaceId = snowflake(message.guild_id, "guildId");
	const thread = threadParents.get(channelId);
	if (thread) {
		return {
			kind: "thread",
			spaceId,
			channelId: snowflake(thread.parentChannelId, "parentChannelId"),
			threadId: channelId,
			authorId,
		};
	}
	return { kind: "channel", spaceId, channelId, authorId };
}

/** Was the bot addressed? Discord marks this in the mentions array. */
export function isBotMentioned(message, botUserId) {
	return Array.isArray(message.mentions) && message.mentions.some((item) => item?.id === botUserId);
}

/** True for bot- or webhook-authored messages. */
export function isAutomatedSender(message) {
	return Boolean(message.author?.bot || message.webhook_id);
}

/**
 * Authorize a raw Discord message against core bindings, doing the Discord
 * mapping first and then deferring the policy to core/binding.authorize.
 */
export function authorizeDiscordMessage({
	message,
	bindings,
	botUserId,
	operatorUserIds = [],
	participantProfiles = null,
	threadParents = new Map(),
}) {
	if (isAutomatedSender(message)) return { allowed: false, reasonCode: "automated_sender" };
	const scope = classifyDiscordScope(message, threadParents);
	return authorize({
		scope,
		bindings,
		isMentioned: isBotMentioned(message, botUserId),
		isAutomated: false,
		operatorUserIds,
		participantProfiles,
	});
}
