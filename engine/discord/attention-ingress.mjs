/**
 * Optional host hook on inbound Discord messages.
 * Engine does not spawn workers. If instance config names a hookModule, this
 * loads it and lets the host decide whether this machine was addressed.
 */
import { pathToFileURL } from "node:url";

export async function enqueueAttentionFromDispatch(type, data, config, instanceDirectory, authorization = null) {
	if (type !== "MESSAGE_CREATE") return { started: false, reason: "ignored" };
	if (!config?.attention?.enabled) return { started: false, reason: "disabled" };
	const hook = config.attention.hookModule;
	if (typeof hook !== "string" || hook.length === 0) return { started: false, reason: "no_hook" };
	const mod = await import(pathToFileURL(hook).href);
	if (typeof mod.handleInboundDiscordMessage !== "function") {
		throw new Error("attention hookModule must export handleInboundDiscordMessage");
	}
	const result = await mod.handleInboundDiscordMessage(data, {
		config,
		instanceDirectory,
		authorization: authorization === null ? null : {
			authorId: authorization.scope?.authorId ?? null,
			participantLabel: authorization.participantProfile?.label ?? null,
			allowedActions: [...(authorization.participantProfile?.allowedActions ?? [])],
			operatorActions: authorization.binding?.operatorActions === true,
			scopeKey: authorization.scopeKey ?? null,
		},
	});
	if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("attention hook must return an object");
	if (result.consumed !== undefined && typeof result.consumed !== "boolean") throw new Error("attention hook consumed must be boolean");
	if (result.started !== undefined && typeof result.started !== "boolean") throw new Error("attention hook started must be boolean");
	return result;
}
