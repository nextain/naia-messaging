/**
 * 호스트마다 다른 도구 이름을 한 어휘로 옮긴다.
 *
 * 2026-09-13 grok 적대리뷰가 찾은 것입니다. 차단이 실증된 가드 다섯을 다시 등록했는데,
 * 그 다섯이 본문에서 `tool_name !== "Bash"` 면 그냥 나갑니다. grok 은 셸을
 * `run_terminal_command`, 편집을 `search_replace` 로 부르므로, matcher 가 훅 프로세스를
 * 띄워 놓아도 스크립트가 이름을 보고 즉시 빠집니다. **등록은 됐는데 발화하지 않습니다.**
 *
 * 이 조사 내내 나온 그 모양입니다. "장치가 있다"와 "장치가 실제로 걸린다"가 벌어지는 자리.
 *
 * 세션 계약 게이트는 이미 같은 표를 갖고 있었습니다
 * (`.codex/hooks/session-contract-gate.cjs`). 한 저장소에 같은 표가 두 벌 있으면 언젠가
 * 갈라지므로, 여기를 정본으로 두고 가드들이 여기서 가져다 씁니다.
 *
 * 이름은 잎만 봅니다. MCP 는 `server__tool`, 일부 호스트는 `functions.name` 처럼
 * 이름공간을 붙입니다.
 */

const SHELL = ["bash", "shell_command", "exec_command", "run_terminal_command"];
const FILE_MUTATION = ["write", "edit", "notebookedit", "apply_patch", "search_replace"];

/** 호스트 도구 이름을 `shell`, `file-mutation`, 또는 원래 잎 이름으로 옮긴다. */
function normalizedToolName(name) {
	const leaf = String(name || "").split(/[.:/]/).pop().toLowerCase();
	if (SHELL.includes(leaf)) return "shell";
	if (FILE_MUTATION.includes(leaf)) return "file-mutation";
	return leaf;
}

/** 셸 계열인가. Claude 의 `Bash` 와 grok 의 `run_terminal_command` 가 같은 답을 받는다. */
const isShellTool = (name) => normalizedToolName(name) === "shell";

/** 파일을 고치는 도구인가. `Edit`/`Write` 와 grok 의 `search_replace` 가 같은 답을 받는다. */
const isFileMutationTool = (name) => normalizedToolName(name) === "file-mutation";

module.exports = { normalizedToolName, isShellTool, isFileMutationTool, SHELL, FILE_MUTATION };
