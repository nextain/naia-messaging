/**
 * Discord adapter — the first transport for the naia-messaging core.
 *
 * It maps Discord's message shape onto core's transport-neutral contracts:
 * scope classification and authorization (scope.mjs), delivery receipts
 * (delivery.mjs), and attachment description (attachments.mjs). It holds no
 * ids, tokens, or instance config — those are supplied at call time.
 */
export {
	classifyDiscordScope,
	isBotMentioned,
	isAutomatedSender,
	authorizeDiscordMessage,
} from "./scope.mjs";
export { postDiscordMessageOnce, deliverToDiscord } from "./delivery.mjs";
export {
	describeDiscordAttachments,
	attachmentSummaryText,
	attachmentPromptSection,
	safeAttachmentName,
} from "./attachments.mjs";
