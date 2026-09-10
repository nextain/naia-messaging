// Discord message text and the model prompt built from it.
//
// This is the whole boundary between untrusted Discord content and the
// host-authored execution contract: mention normalization, attachment
// description, the bounded request text, the assembled prompt, and the one
// JSON shape the model may return to ask for a DM. It is separated from the
// router so that changing what the model is told does not mean editing the
// job lifecycle, and so these functions can be tested without a store,
// a Gateway or a running job.

import { attachmentPromptSection } from "./discord-attachments.mjs";
import { trustedParticipantPolicy } from "./discord-conversation.mjs";
import { currentExecutionProfile, effectiveAllowedActions } from "./execution-profile.mjs";
import { grokDiscordCost } from "./grok-cost-profile.mjs";

// 알림은 이미 조립된 문자열에 끼워 넣지 않고 `User request:` 파트 앞에 별도
// 파트로 넣는다. 마커를 찾아 삽입하면 이전 프롬프트를 붙여 넣어 본문에
// `User request:` 줄이 들어간 사용자의 글 안쪽으로 알림이 들어가고, 대화 이력
// 로더가 맞춰 보는 접미사도 함께 깨진다.
const MUTATION_WINDOW_CLOSED_NOTICE = "Mutation window: The participant mutation window is closed. This request is read-only; do not write or execute.";

/**
 * 한 Discord 메시지가 담은 요청 전체. 본문 글과 첨부 서술을 합친다.
 *
 * 첨부를 여기서 합치는 이유는 두 가지다. 프롬프트와 복구 봉투가 같은 문자열을
 * 쓰게 되어 재시도해도 파일 정보가 사라지지 않고, 파일만 보낸 메시지가 "빈 요청"
 * 으로 판정되어 조용히 버려지지 않는다.
 */
export function discordRequestText(message, botUserId, { authorization = null, instance = null } = {}) {
	if (typeof message.content !== "string" || message.content.length > 4_000) throw new Error("Discord content is missing or too large");
	const userText = normalizedDiscordText(message.content, botUserId);
	const attachmentSection = attachmentPromptSection(message, {
		channelId: authorization?.scope?.threadId ?? authorization?.scope?.channelId ?? null,
		instance,
	});
	return [userText, attachmentSection].filter(Boolean).join("\n\n");
}

export function transientPrompt(message, botUserId, config, authorization = null, agentContextSnapshot = null, { instance = null, accessCeiling = null } = {}) {
	return boundRequestPrompt(discordRequestText(message, botUserId, { authorization, instance }), config, authorization, agentContextSnapshot, accessCeiling);
}

// 사용자 본문 4,000자에 우리가 만든 첨부 블록이 더해질 수 있다. 그 블록은 파일
// 10개까지, 이름은 각 120자로 묶여 있어 1.5KB 를 넘지 않는다.
export const MAX_REQUEST_TEXT_LENGTH = 6_000;

export function boundRequestPrompt(userText, config, authorization = null, agentContextSnapshot = null, accessCeiling = null, { windowClosed = false } = {}) {
	if (typeof userText !== "string" || !userText || userText.length > MAX_REQUEST_TEXT_LENGTH) throw new Error("Discord prompt is empty or too large");
	const authorityActions = effectiveAllowedActions(config, authorization);
	// 상한이 걸린 제출은 프롬프트에 적히는 행동 목록부터 낮춘다. 실행 프로필만
	// 낮추고 목록을 그대로 두면 모델이 허용된다고 읽는다.
	const allowedActions = accessCeiling === "read-only"
		? authorityActions.filter((action) => action !== "write" && action !== "execute")
		: authorityActions;
	const backendId = config.backend?.selected ?? "codex";
	const executionProfile = currentExecutionProfile(config, backendId, authorization, { accessCeiling });
	const costProfile = config.backend?.profiles?.[backendId]?.costProfile ?? (backendId === "codex" || backendId === "grok" ? "balanced" : "provider-default");
	const grokCost = backendId === "grok" ? grokDiscordCost(costProfile) : null;
	const parts = [];
	if (agentContextSnapshot) parts.push(agentContextSnapshot.prefix, "");
	parts.push(`Persona: ${config.persona.name}`, config.persona.instructions, `Role: ${config.role.name}`);
	if (config.schemaVersion === 2) parts.push(trustedParticipantPolicy({ participantProfile: authorization?.participantProfile, effectiveActions: allowedActions }));
	if (config.schemaVersion === 2 && Array.isArray(config.workspace?.allowedPaths)) parts.push(`Allowed workspace paths: ${config.workspace.allowedPaths.join(", ")}. Use only these explicitly configured project paths; do not access other projects.`);
	parts.push(
		`Allowed actions: ${allowedActions.join(", ")}`,
		grokCost
			? `Gateway execution contract: ${executionProfile.access}. Cost profile: ${costProfile} (development ${grokCost.developmentProfile}, grok-4.6 ${grokCost.reasoningEffort}).`
			: `Gateway execution contract: ${executionProfile.access}. Cost profile: ${costProfile}.`,
		executionProfile.access !== "read-only"
			? executionProfile.access === "danger-full-access"
				? "The host has verified the sole operator, DM-only Discord binding, project context, and trusted-local no-prompt policy for this request. This Gateway execution contract grants the current OS user's local access for the current job. It does not grant root authority or broaden the user's request. Use only the configured actions and the resources needed to complete that bounded request."
				: "The host has verified the operator, Discord binding, participant action intersection, project context, and no-prompt policy for this request. This Gateway execution contract is the explicit mutation authority for the current job. Do not downgrade it to read-only merely because no interactive session binding exists. Mutate only inside the configured workspace and granted actions."
			: "This job is read-only. Do not modify files, repository state, services, or external systems.",
		"Routine authority: A bounded user request authorizes its normal in-scope execution path. Treat workflow phase gates, including Understand, Scope, Plan, Sync, and Close, as internal checkpoints; do not ask the user to approve them.",
		"No approval click is available in this unattended session. Never request or wait for interactive approval.",
		"Authority limit: Ask only when a material unresolved choice would change the requested scope. If an action is outside the granted actions, stop safely and report the limitation without expanding authority or claiming completion.",
		"Current-turn truthfulness: Never promise to continue, resume, deploy, or report later after this job ends. In the current job, either perform and verify the concrete bounded work, or state the exact missing request, authority, credential, or external precondition. A prior failed or terminal job is not automatically resumed; do not imply that it is running.",
		"Communication: Reply in the language used by the user. Before tool work, provide a brief analysis and action plan as an intermediate update. During long work, report meaningful findings or phase changes before the final verified result. Do not repeat generic status text.",
		"Discord access: Do not access Discord directly. If the operator explicitly requests a separate DM, return exactly one discordDm JSON object; the gateway will deliver it only to the fixed workspace-owner recipient.",
	);
	if (windowClosed) parts.push("", MUTATION_WINDOW_CLOSED_NOTICE);
	parts.push("User request:", userText);
	return parts.join("\n");
}

export function parseDiscordDmRequest(value) {
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1) return null;
		const request = parsed.discordDm;
		if (!request || typeof request !== "object" || Array.isArray(request)) return null;
		if (typeof request.content !== "string" || request.content.length < 1 || request.content.length > 2_000) return null;
		if (typeof request.successReply !== "string" || request.successReply.length < 1 || request.successReply.length > 2_000) return null;
		if (typeof request.failureReply !== "string" || request.failureReply.length < 1 || request.failureReply.length > 2_000) return null;
		return request;
	} catch { return null; }
}

export function commandText(message, botUserId) {
	return normalizedDiscordText(String(message.content ?? ""), botUserId);
}

function normalizedDiscordText(value, botUserId) {
	return String(value)
		.replaceAll(`<@${botUserId}>`, "")
		.replaceAll(`<@!${botUserId}>`, "")
		.replace(/<@!?\d{17,20}>/g, "[Discord user mention]")
		.replace(/<@&\d{17,20}>/g, "[Discord role mention]")
		.replace(/<#\d{17,20}>/g, "[Discord channel mention]")
		.trim();
}
