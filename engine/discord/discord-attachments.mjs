/**
 * Discord 첨부를 에이전트가 볼 수 있는 형태로 서술한다.
 *
 * 게이트웨이는 오랫동안 `message.content` 만 프롬프트로 옮겼다. 내려받는 기능은
 * `discord-history.mjs` 에 갖춰져 있었지만, 첨부 ID 를 알려주는 표면이 없어서
 * 에이전트가 그 기능을 부를 수가 없었다. 글과 함께 온 파일은 없는 것처럼 보였고,
 * 파일만 온 메시지는 본문이 비어 있다는 이유로 조용히 버려졌다.
 *
 * 여기서 만드는 것은 "무엇이 붙어 있는지"와 "그것을 어떻게 가져오는지" 두 줄이다.
 * 실제 다운로드는 기존 경로를 그대로 쓴다.
 */
import { describeDiscordAttachments } from "../../adapters/discord/attachments.mjs";
export { safeAttachmentName, describeDiscordAttachments, attachmentSummaryText } from "../../adapters/discord/attachments.mjs";
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * 프롬프트에 넣을 블록. 파일을 실제로 여는 방법까지 함께 준다. 식별자만 주면
 * 에이전트가 그것으로 무엇을 해야 하는지 몰라 다시 되묻게 된다.
 */
export function attachmentPromptSection(message, { channelId = null, instance = null } = {}) {
	const { attachments, omitted } = describeDiscordAttachments(message);
	if (attachments.length === 0) return "";
	const messageId = String(message?.id ?? "");
	const lines = ["Attached files:"];
	for (const item of attachments) {
		const size = item.size === null ? "unknown size" : `${item.size} bytes`;
		const type = item.contentType ? `, ${item.contentType}` : "";
		lines.push(`- ${item.filename} (${size}${type}) attachmentId=${item.attachmentId}`);
	}
	if (omitted > 0) lines.push(`- (${omitted} more attachment(s) were not listed)`);
	lines.push(
		"These files are not readable until you download them. Use the manage-discord-sessions skill:",
		`  node .agents/skills/manage-discord-sessions/helper/cli.mjs attachment${instance ? ` --instance ${instance}` : ""}${channelId && SNOWFLAKE.test(channelId) ? ` --channel ${channelId}` : ""}${SNOWFLAKE.test(messageId) ? ` --message ${messageId}` : ""} --attachment <attachmentId> --output <absolute path>`,
		"Download into a temporary working directory, read the file, and then answer. Never claim you cannot read an attached file without attempting this download first.",
	);
	return lines.join("\n");
}
