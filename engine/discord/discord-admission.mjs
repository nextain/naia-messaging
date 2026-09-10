import { randomUUID } from "node:crypto";

export const RUNTIME_INPUT_CHANGED_NOTICE = "서비스 설정 또는 프로젝트 규칙이 변경되어 이번 요청을 처리하지 않았습니다. 검토 후 서비스를 재시작해 주세요. / Runtime policy changed; this request was rejected. Review the change and restart the service.";
export const PROMPT_INVALID_NOTICE = "이 메시지에서 처리할 요청을 찾지 못했습니다. 요청할 내용을 글로 적어 주세요. / No actionable request was found in that message; please describe what you need in text.";
export const AUTHORITY_UNAVAILABLE_NOTICE = "현재 요청의 권한 또는 실행 구성을 확인할 수 없어 처리하지 않았습니다. 설정을 확인한 뒤 다시 보내 주세요. / The request could not be admitted because its authority or execution configuration is unavailable; check the configuration and retry.";

/**
 * Reserve a rejected ingress and notify the authorized Discord scope once.
 * The router supplies its private outbound wrapper so this helper cannot send
 * to an arbitrary channel or bypass the router's shutdown tracking.
 */
export function rejectDiscordAdmission({ store, sendControl, token, botUserId, authorization, sourceMessageId, sequence, reasonCode, content, includeJobId = true }) {
	const ingress = store.reserveIngress({ sourceMessageId, scopeKey: authorization.scopeKey, status: "rejected", reasonCode, dispatchSequence: sequence });
	if (ingress.duplicate) return includeJobId ? { state: "duplicate", reasonCode, jobId: ingress.jobId } : { state: "duplicate", reasonCode };
	const channelId = authorization.scope.threadId ?? authorization.scope.channelId;
	void sendControl({ token, channelId, botUserId, content, nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise.catch(() => {});
	return { state: "rejected", reasonCode };
}

export function rejectRuntimeInputChange(args) {
	return rejectDiscordAdmission({ ...args, reasonCode: "context_changed_restart_required", content: RUNTIME_INPUT_CHANGED_NOTICE, includeJobId: false });
}
