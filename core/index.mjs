/**
 * naia-messaging core — the transport-neutral conversation layer.
 *
 * Nothing here knows a transport. An adapter (adapters/discord, and a future
 * self-hosted messenger) maps its platform's messages onto these contracts,
 * and a runtime wires an instance's config to them. Instances hold config;
 * the code lives here.
 */
export * from "./redact.mjs";
export * from "./identity.mjs";
export * from "./binding.mjs";
export * from "./verdict.mjs";
export * from "./confirmation.mjs";
export * from "./contact-window.mjs";
export * from "./delivery.mjs";
export { reconcile } from "./monitors/reconcile.mjs";
