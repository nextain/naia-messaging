**English** | [한국어](README.ko.md)

# naia-messaging

The conversation layer between people and agents. The core knows nothing about the transport.
Discord is the first adapter; our own distributed messenger is the next one.

This repository holds **code only**. Bot tokens, real channel and thread identifiers, participant
rosters, host names, and the like are not kept here. Those stay in each instance's configuration
(personal ADK, team ADK), and the code that fixes problems lives in this one place.

## Why transport-neutral

The rules of conversation — who is a participant, which work item a thread is bound to, how an
acknowledgement differs from a reply, what to write when asking for confirmation, attention routing
that keeps bot chatter from landing on people who did not ask for it, when it is acceptable to contact
a person, and whether delivery really happened — are the same on Discord or any other messenger.
Those rules live in `core`, and each transport's specifics are handled by its adapter. Changing the
transport is not a rewrite; it is adding one more adapter.

## Code structure

- **`core/`** — transport-neutral contracts and logic.
  - `identity` Participants and identity (`[alias/project]`). Platform identifiers belong to the
    adapter, are not the identity, and are not shown to people.
  - `binding` Thread ↔ work-item binding, and attention routing. In shared spaces the default is to
    respond "only when called", so work does not land on people who did not ask for it.
  - `attention` Who a message called. The adapter passes only handle tokens, and `localAttention`
    decides whether this machine was called. Starting a worker is the host's job, not a QA round.
  - `verdict` Posted ≠ received ≠ started. An acknowledgement such as `[메시지 받음]` ("message
    received") is only a start receipt, not a reply. Whose turn it is depends on whether a real reply
    came after the last human message.
  - `confirmation` The four parts of a confirmation request: who, what, exactly where, and where to
    report.
  - `contact-window` Requests and reminders only inside the contact window; failure alerts at any
    time. Time outside the window does not count toward the number of reminders.
  - `delivery` Delivery receipts: confirmed / failed / unknown. The three are never merged.
  - `monitors` Monitoring logic such as reconciliation. It does not fix anything; it only reports
    where things have drifted.
- **`adapters/discord/`** — The Discord adapter. It classifies and authorizes raw messages into
  neutral scopes, translates delivery attempts into core receipts, and describes attachments. The
  adapter for our own messenger is listed as planned in [`adapters/README.md`](adapters/README.md).
- **`engine/discord/`** — The Gateway loop, backend run and cancel, the SQLite ledger, and the service, monitoring, cutover, and recovery engines. ADK skills keep only compatibility entry points that call these modules.
- **`runtime/`** — Config shape validation, pinned package installation, and a JSONL API that connects to an existing host ledger. It contains no real configuration.

## Consumer installation and API

Requires Node.js 22.13 or later, with no external runtime dependencies. Consumers pin the
repository, the exact commit, and the SHA-256 of the whole package in `engine-lock.json`.
`installEngineSnapshot()` in `runtime/engine-snapshot.mjs` installs the whole of LICENSE,
package.json, core, adapters, engine, and runtime into a new path. Include this package in the run
artifact and rollback output, and verify its full integrity with the host's trusted bootstrap before
running. Do not modify the installed copy directly.

JavaScript consumers use the `engine/discord/*` API. Existing hosts such as Python ones use the
version 1 JSONL pipe in `runtime/host-bridge.mjs`. `gateway` mode commits the received sequence only
after waiting for the host's `state` and `dispatch` ACKs, and keeps handling heartbeat control.
For a clean shutdown, the host sends `{"version":1,"operation":"stop"}` over the same pipe and keeps
answering `dispatch` and `state` until it receives the `stopped` receipt and a clean exit.
It confirms up to the last sequence ACK of dispatches that have already started, and frames that
have not started resume from the existing checkpoint. If it cannot drain within 12 seconds or an ACK
fails, it exits with failure and no success receipt. The host also does not reconnect before the
previous callback cleanup has finished. EOF and process signals do not replace the clean shutdown
request and keep the existing failure path.
`call` mode performs a single `scope`, `redact`, or `delivery` call. `backend` mode runs one
already-claimed job and refuses to re-run the same job using a separate execution-evidence ledger.
The host remains the source of truth for the job queue, approvals, recipients, and outbox. Platform
messages and model output are not RPC.

If a send result is `unknown`, it is not automatically resent. Nonces already stored are kept as they
are. Notifications are allowed through an explicit allowlist only when a registered person is called
directly on the actual first line. The Discord token and gateway configuration environment are not
passed to backend processes. On Linux, a separate guardian keeps ownership of the process group so
that child processes in the same group are cleaned up even after the backend exits. A run whose
cleanup could not be confirmed is not reported as successful. Per-instance former names of
credential profiles are registered as aliases only in the consumer's trusted code.


## Host orchestration contract

The queue, approvals, outbox, and worktrees belong to the host, so the orchestration rules are
written as a contract rather than as code. Full text:
[`docs/host-orchestration-contract.md`](docs/host-orchestration-contract.md) (Korean).

- Open issues are not automatically re-queued on a timer. What moves work forward is a human message.
- Claim order is human message → operator intake → automation. A human follow-up is not downgraded
  to a read-only review because of the previous failure.
- Model answers are delivered as-is with only redaction and the mention allowlist applied. They are
  not discarded because of a pre-validation failure.
- Approval is asked only for three things (high-risk operations, high-traffic queries, decisions only
  a person can make), and the operator's thread reply is itself the approval. Insufficient preparation
  is not a reason to ask for approval.
- Jobs run in per-issue worktrees, with at most one at a time for the same issue. The backend is
  single-turn, and if `stopReason` is not `end_turn`, it is an interruption, not completion.

## Verification

```
npm test
```

Runs the unit tests (`node --test test/`) and then the public safety scan
(`scripts/public-safety-scan.mjs`). The safety scan fails the build if it finds secrets or
instance-specific data (private keys, tokens, IPs, 17–20 digit identifiers, emails, instance domains)
in tracked files or git history.

## Public status

This is a public repository. Real instance data and credentials stay on the consumer side.
Before shared code is released, the full tree and Git history must pass the public safety scan.
