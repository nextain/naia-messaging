/**
 * Optional host hook on inbound Discord messages.
 * Engine does not spawn workers. If instance config names a hookModule, this
 * loads it and lets the host decide whether this machine was addressed.
 */
import { pathToFileURL } from "node:url";

export async function enqueueAttentionFromDispatch(type, data, config, instanceDirectory) {
	if (type !== "MESSAGE_CREATE") return { started: false, reason: "ignored" };
	if (!config?.attention?.enabled) return { started: false, reason: "disabled" };
	const hook = config.attention.hookModule;
	if (typeof hook !== "string" || hook.length === 0) return { started: false, reason: "no_hook" };
	const mod = await import(pathToFileURL(hook).href);
	if (typeof mod.handleInboundDiscordMessage !== "function") {
		throw new Error("attention hookModule must export handleInboundDiscordMessage");
	}
	return mod.handleInboundDiscordMessage(data, { config, instanceDirectory });
}
