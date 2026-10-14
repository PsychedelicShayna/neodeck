import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { ModelRef } from "@npi-deck/protocol";

export const DEFAULT_MODEL_CANDIDATES = [
	{ provider: "anthropic", id: "claude-opus-5-5" },
	{ provider: "github-copilot", id: "claude-opus-5.5" },
	{ provider: "openrouter", id: "anthropic/claude-opus-5.5" },
] as const;
export const FALLBACK_MODEL_CANDIDATES = [
	{ provider: "openai-codex", id: "gpt-6-sol" },
	{ provider: "github-copilot", id: "gpt-6-sol" },
	{ provider: "openrouter", id: "openai/gpt-6-sol" },
] as const;
export function firstAuthenticatedModel(registry: ModelRegistry, candidates: readonly ModelRef[]) {
	for (const { provider, id } of candidates) {
		const model = registry.find(provider, id);
		if (model && registry.hasConfiguredAuth(model)) return model;
	}
	return undefined;
}
