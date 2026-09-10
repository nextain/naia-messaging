export const GROK_AVAILABLE_BINDINGS = "grok_flagship,grok_workhorse,grok_light";

// Discord costProfile names stay control/balanced/economy so an operator can
// switch backends without rewriting the config shape. The efforts are not the
// Codex Discord table: Codex balanced pins low, while Grok balanced is the
// grok-balanced secretary default (4.6 medium).
export const GROK_DISCORD_COST_BY_PROFILE = Object.freeze({
	control: Object.freeze({ developmentProfile: "grok-control", reasoningEffort: "high" }),
	balanced: Object.freeze({ developmentProfile: "grok-balanced", reasoningEffort: "medium" }),
	economy: Object.freeze({ developmentProfile: "grok-economy", reasoningEffort: "low" }),
});

export function grokDiscordCost(costProfile = "balanced") {
	const selected = GROK_DISCORD_COST_BY_PROFILE[costProfile];
	if (!selected) throw new Error("unsupported Grok cost profile");
	return selected;
}
