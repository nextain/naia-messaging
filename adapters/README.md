# Adapters

An adapter maps one transport's messages onto the transport-neutral contracts
in [`../core`](../core). Core defines *what* a conversation is — participants,
bindings, verdicts, delivery receipts, contact windows, monitors — and an
adapter supplies the *how* for one platform. An adapter holds no instance
configuration and no real ids; those are passed in at call time.

## Present

- **`discord/`** — the first adapter. Classifies a Discord message into a
  neutral scope and authorizes it (`scope.mjs`), performs delivery attempts and
  maps them onto core's confirmed / failed / unknown receipts (`delivery.mjs`),
  and describes attachments so the engine can fetch them (`attachments.mjs`).

## Planned

- **Self-hosted messenger** — the second adapter. Naia's own distributed
  messenger will implement the same core contracts: it will classify its
  messages into `dm` / `channel` / `thread` scopes, provide a `postOnce`
  returning a core delivery receipt, and reuse core's identity, binding,
  verdict, confirmation, contact-window, and monitor logic unchanged.

The point of the split is that a transport change is an adapter, not a rewrite:
core and every instance's config stay put.
