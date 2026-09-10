/**
 * Generic monitoring logic, transport-neutral and config-free.
 *
 * These are the reusable checks a per-host runtime schedules. They carry no
 * host, guild, channel, or issue specifics — those come from an instance's
 * config at call time. The scheduling units (systemd timers, cron) and the
 * outer watchdog placement are runtime concerns, documented in runtime/.
 */
export { whoseTurn, classifyAgentMessage } from "../verdict.mjs";
export { reconcile } from "./reconcile.mjs";
export { shouldContact, withinContactWindow, normaliseContactWindow } from "../contact-window.mjs";
