# Runtime install notes

The runtime is the per-host service that wires an instance's config to the
[`core`](../core) contracts through an [`adapter`](../adapters). This repository
ships **no instance config and no secrets**. An instance supplies those.

## What an instance provides (never this repo)

- A **config file** (see [`config.sample.json`](./config.sample.json)) with the
  transport, the *name* of the env var holding the bot token, the path to a
  private participant registry, the contact window, and the bindings. Copy it to
  a `*.local.json` file — those are git-ignored here.
- The **bot token**, only in the environment variable the config names. Never in
  a file in this repository.
- The **participant registry** (real people ↔ platform ids). It lives in the
  instance and is validated against `core/identity.validateParticipantRegistry`.
- The **monitor schedule** (systemd timers, cron) and the **outer watchdog**.
  Core provides the monitor *logic*; where and how often it runs, and where the
  watchdog sits, are instance/runtime decisions. The watchdog must sit outside
  the monitored host — an inner watchdog dies with the thing it watches.

## Validating a config

```
node runtime/cli.mjs validate-config path/to/config.local.json
node runtime/cli.mjs check-token   path/to/config.local.json   # set/unset + length only
```

`validate-config` checks the shape only, using core's own validators, so the
runtime and the engine agree on what a valid config is. `check-token` reports
whether the named env var is set and its length — never the value.

## Monitor scheduling (instance side)

Schedule core's monitors (`core/monitors`) as the instance sees fit, following
the contract the source instances learned the hard way:

- Verify in the target runtime; a hand-run is not a verification.
- Guard on an unmet precondition by exiting non-zero — never continue silently.
- If a state query fails, fail closed: do not queue new work when you cannot
  tell whether the engine is busy.
- Prove failure notification by deliberately failing a unit and confirming the
  alert arrives. A unit finishing is not proof an alert was delivered.
