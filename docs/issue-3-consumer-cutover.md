# 소비자 전환 계약 — nextain/naia-messaging#3

조율: nextain/naia-comm#13. 개인 ADK 껍질: nextain/naia-adk#53.
이 문서는 공개 저장소에 남는다. 호스트 이름, 채널 식별자, 토큰, 참가자 명부는 적지 않는다.

## 이해 (UNDERSTAND)

- 목표: 라이브 Discord 수신기가 이 패키지의 핀된 엔진 스냅샷을 실행한다. 인스턴스는 설정·자격·업무 정책만 갖는다.
- 제약: 기존 큐·전달 원장·토큰 단일 소유를 보존한다. 불명확한 전달을 자동 재시도하지 않는다. 알파 채널 수신은 전환 중에도 살아 있어야 한다. 인스턴스 고유 값은 이 저장소에 넣지 않는다.
- 판정: 소비자가 `engine/`를 복사하지 않고 `runtime/engine-snapshot.mjs`로 설치·검증한 뒤 그 스냅샷의 `engine/discord/service.mjs`를 실행한다. digest 불일치는 이전 런타임을 유지한다.

## 범위 (SCOPE)

- L1: 이 저장소의 core / adapters / engine / runtime 계약과 소비자 전환 검사.
- L2: 개인 ADK 스킬이 스냅샷을 고르는지(구현은 naia-adk#53).
- L3: 기존 `manage-discord-sessions` 헬퍼는 소비자의 구 경로. 여기서 수정하지 않는다.
- 이번 브랜치에서 하지 않는 것: 지정 기기 실전환, 팀 인스턴스 전환, 자체 메신저 어댑터.

## 기능요소 (FE)

| ID | 요구 | 상태 |
|---|---|---|
| FE-CUTOVER-1 | `core/`는 어댑터·엔진을 import하지 않는다. 전송 수단 식별자는 core 계약에 없다. | 검사 |
| FE-CUTOVER-2 | Discord 전송 사정은 `adapters/discord/`만 안다. | 검사 |
| FE-CUTOVER-3 | 실행 엔진은 `engine/discord/`가 소유한다. 소비자는 이 트리를 복사해 고치지 않는다. | 검사 |
| FE-CUTOVER-4 | 설치는 `runtime/engine-snapshot.mjs`의 핀 lock(저장소·revision·snapshotSha256)만 허용한다. digest 불일치·심링크·외부 의존성은 거부하고 목적지를 활성화하지 않는다. | 검사 |
| FE-CUTOVER-5 | 패키지는 런타임 npm 의존성을 갖지 않는다. | 검사 |
| FE-CUTOVER-6 | 인스턴스 설정·비밀·참가자 명부는 이 저장소에 없다. 샘플 설정만 형태를 보여 준다. | 검사 |
| FE-CUTOVER-7 | 소비자 실전환·롤백 증거는 각 비공개 인스턴스 이슈에 남긴다. 이 저장소의 통과가 라이브 전환을 의미하지 않는다. | 문서 |

## 유저시나리오 (UC)

| ID | 누가 → 무엇을 → 왜 |
|---|---|
| UC-CUTOVER-1 | 유지관리자가 패키지를 고친다. 모든 개인·팀 ADK는 같은 스냅샷을 올려 받는다. Discord 결함을 저장소마다 고치지 않기 위해서다. |
| UC-CUTOVER-2 | 운영자가 개인 ADK에서 엔진을 설치한다. lock이 맞으면 새 버전이 생기고, 틀리면 기존 수신기가 그대로 돈다. |
| UC-CUTOVER-3 | 사람이 지정 채널에서 봇에게 일을 맡긴다. 전환 뒤에도 수신·한 번 실행·전달 영수증이 남고, 전달이 불명이면 재전송하지 않는다. |
| UC-CUTOVER-4 | 전환이 실패하면 이전 generation이 채널을 계속 받는다. 알파 채널이 빈 시간이 생기면 안 된다. |

시나리오 상세:

- S-CUTOVER-1: `compose` 없음. `verifyEngineSnapshot` / `installEngineSnapshot`이 lock과 바이트를 대조한다.
- S-CUTOVER-2: core 파일이 `../adapters` 또는 `../engine`을 import하면 실패한다.
- S-CUTOVER-3: 패키지 `dependencies`가 있으면 스냅샷 설치가 거절된다.

## 유닛테스트 (UT)

`test/consumer-cutover.contract.test.mjs`

- core 상대 import가 adapters/engine을 가리키지 않는다.
- package.json name·exports·dependencies 계약.
- 잘못된 digest lock은 `verifyEngineSnapshot`이 throw 한다.

## 통합테스트 (ET)

같은 파일의 스냅샷 설치 경로:

- 올바른 lock으로 임시 목적지에 설치하면 같은 digest가 나온다.
- 이미 같은 digest가 있으면 재복사하지 않고 목적지를 반환한다.
- 기존 `test/engine-runtime.test.mjs`의 ACK·graceful stop·backend 정리 계약을 회귀로 유지한다.

라이브 채널 한 턴은 이 저장소에서 돌리지 않는다. 개인 fork 이슈에 영수증을 남긴다.

## 품질케이스 (QC)

번호는 회차 부여 전 초안이다. 공개 저장소라 식별자를 넣지 않는다.

| 초안 ID | 준비 | 방법 | 기대 |
|---|---|---|---|
| QC-CUTOVER-A | 깨끗한 패키지 트리 | `npm test` | 단위·스냅샷·공개 안전성 0 |
| QC-CUTOVER-B | 핀 lock 불일치 사본 | `verifyEngineSnapshot` | throw, 기존 런타임 파일 무변경 |
| QC-CUTOVER-C | 개인 ADK 알파 인스턴스 | 전환 전 health-check | healthy, 활성 job 0 또는 기존 작업만 |
| QC-CUTOVER-D | 알파 업무 채널에서 한 줄 | 전환 후 한 턴 | 수신·실행·전달 영수증. 엔진 lock SHA가 이슈에 남음 |
| QC-CUTOVER-E | 고의 digest 불일치 후보 | 설치 시도 | 이전 generation이 계속 수신 |

C–E는 인스턴스 이슈에서만 실행한다.

## 조사 결과 (INVESTIGATE)

1. 패키지 `origin/main`은 엔진을 포함한다(`engine/discord/*`, `runtime/engine-snapshot.mjs`). PR #4 병합.
2. 라이브 개인 수신기는 여전히 인스턴스 `managed-runtimes/.../manage-discord-sessions/helper/service.mjs`를 실행한다. 패키지 import 없음.
3. 개인·팀 ADK package.json에 이 패키지 의존이 없다. 팀 게이트웨이 CLI는 구 스킬 스크립트를 부른다.
4. 어댑터 서술자는 스냅샷 존재가 실행 채택이 아니라고 명시한다.
5. core 내부 경계는 유지된다. 사용 경계가 닫히지 않은 것이 결함이다.

연속 두 번 같은 다섯 항 외에 새 항목 없음.

## 계획 (PLAN)

1. 이 브랜치: 전환 계약 문서 + 결정론 검사. 검증: `npm test`.
2. naia-adk#53: 스킬을 스냅샷 설치·실행의 얇은 껍질로. 검증: 기존 스킬 테스트 + 스냅샷 verify.
3. 개인 fork 알파 인스턴스: cutover canary, 실패 시 이전 generation. 검증: QC-CUTOVER-C/D/E.
4. 팀 인스턴스는 알파 안정 후.

실패 시나리오: (1) 스냅샷과 헬퍼가 동시에 같은 토큰을 물어 수신이 갈린다 → 단일 소유 lock을 전환 전제로 둔다. (2) digest 불일치를 무시하고 기동한다 → verify 실패는 설치 거부. (3) 이 문서 통과를 라이브 완료로 보고한다 → FE-CUTOVER-7.

## 이번 커밋이 아닌 것

지정 기기 실전환, 아이폴 운영 배포, Grok 로그인. 아이폴 운영은 nextain/aipol-lab#10.
