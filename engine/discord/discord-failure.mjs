import { randomUUID } from "node:crypto";

const FAILURE_TEXT = Object.freeze({
	no_progress_timeout: "일정 시간 동안 진행이 없어 작업을 중단했습니다.",
	timeout: "작업 제한 시간을 초과해 중단했습니다.",
	process_exit: "작업 프로세스가 비정상 종료됐습니다.",
	provider_quota_exhausted: "코딩 백엔드의 사용량 한도 또는 잔액이 소진되어 작업을 시작하지 못했습니다.",
	approval_ui_detected: "승인 입력을 요구하는 실행이 감지되어 안전하게 중단했습니다.",
	context_changed_restart_required: "프로젝트 규칙이 서비스 시작 후 변경되어, 새 규칙을 다시 읽도록 작업을 중단했습니다.",
	discord_history_load_failed: "Discord 대화 기록을 불러오는 단계에서 실패했습니다.",
	backend_version_probe_failed: "코딩 백엔드 실행 파일 확인 단계에서 실패했습니다.",
	backend_authentication_failed: "코딩 백엔드 인증 준비 단계에서 실패했습니다.",
	backend_invocation_invalid: "코딩 백엔드 실행 인자 구성 단계에서 실패했습니다.",
	backend_spawn_failed: "코딩 백엔드 프로세스 시작 단계에서 실패했습니다.",
		mutation_window_closed: "설정된 변경 작업 시간이 닫혀 쓰기 작업을 시작하지 않았습니다. 시간창이 열린 뒤 다시 요청하거나 서비스를 재시작하세요.",
	internal_error: "작업 중 내부 오류가 발생했습니다.",
});

function failureReason(job) {
	const match = String(job?.latestSafeError ?? "").match(/^Job failed: ([a-z0-9_]+)$/);
	return match?.[1] ?? "internal_error";
}

export function failureNotice(job, jobId = job?.jobId) {
	if (!job || !["failed", "recovery_review"].includes(job.lifecycle)) return null;
	const detail = job.lifecycle === "recovery_review"
		? "전달 또는 복구 상태가 불확실해 자동 재실행하지 않고 검토 대상으로 보존했습니다."
		: FAILURE_TEXT[failureReason(job)] ?? FAILURE_TEXT.internal_error;
	return `작업을 완료하지 못했습니다. ${detail}\n작업 ID: ${jobId}`;
}

export async function reportDiscordJobFailure({ item, store, token, botUserId, sendControl }) {
	const content = failureNotice(store.getJob(item.jobId, { includeEvents: false }), item.jobId);
	if (content === null) return;
	try {
		await sendControl({ token, channelId: item.channelId, botUserId, content, nonce: randomUUID().replaceAll("-", "").slice(0, 24) }).promise;
	} catch {}
}
