# 주의 계층 — 불리면 깨운다 (전송 중립)

QA 회차 큐가 아니다. 채널 메시징이다.

## 문제

다른 기기·세션에 일을 주려면 그 참가자를 **불러야** 한다. Git 큐는 실행자가
이미 떠 있을 때만 가져간다. 꺼진 실행자는 다음 회차를 모른다. 봇 글을 채널에
올리는 것도 수신이 아니다.

## 층

| 층 | 하는 일 | 하지 않는 일 |
|---|---|---|
| `core/attention` | 토큰·본문에서 누구를 불렀는지 가린다 | Discord, 프로세스 기동, QA 회차 |
| `adapters/<transport>/attention` | 그 전송의 멘션·본문을 핸들 토큰으로 옮긴다 | 명부·토큰 저장 |
| 호스트 | 이 기계의 identity가 불렸으면 워커를 켠다 | core에 운영 취향을 넣지 않는다 |

게시 ≠ 수신 ≠ 시작은 그대로다. attention 일치는 시작 영수증이 아니다. 호스트가
워커를 켠 뒤에야 시작이다.

## 이미 있는 코드

- `core/attention.mjs` — `resolveAttention`, `localAttention`
- `adapters/discord/attention.mjs` — 멘션 id → 인스턴스 alias, 본문 핸들 스캔은 core
- 단위 테스트: `test/core.test.mjs`, `test/adapters-discord.test.mjs`

## 호스트가 이어서 할 일 (다른 세션)

1. 인스턴스 참가자 명부에 `handles`(기기 호칭)를 둔다. 예: alias `naia3090`, handles `["3090"]`.
2. 게이트웨이가 사람 메시지를 받을 때 `resolveAttention` / `resolveDiscordAttention`을 부른다.
3. `localAttention({ attention, localIdentities })` 가 `named`이면 그 호스트의 워커를 켠다.
4. 워커가 하는 일은 유연하다. 이슈를 읽고, 코드를 받고, 참여한다. QA `qa-executor --round`에 묶지 않는다.
5. 시작 영수증은 워커가 실제로 시작한 뒤에 남긴다.

자율 continuation은 넣지 않는다. 사람 메시지가 일을 움직인다.

## 검증

```
cd naia-messaging && npm test
```
