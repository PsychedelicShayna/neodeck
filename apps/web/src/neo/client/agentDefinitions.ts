/**
 * Templates and instances, as one catalogue for the Agents and Threads pages.
 *
 * A template is configuration plus provenance; it never has a status. An
 * instance is something running (or that ran) from a template, with identity,
 * lifecycle and the actions NeoPi permits. Main is an instance like any other.
 *
 * Deck-authored templates and native instances are live (`agentTemplates`,
 * `agentInstances`). NeoPi's own definitions (`.omp/agents/*.md`,
 * `WATCHDOG.toml`, Chronicler) can't be listed until NeoPi exposes
 * `list_agent_definitions`, and nothing can start an instance from a template
 * until neopi#11 settles the flat agent model. Both stay behind the
 * `agentDefinitions` / `agentSpawn` preview domains; the contract is in
 * ~/.cache/npi-canary/neodeck-pool/upstream-needs/AgentsPhilosopher.md.
 */
import { useSyncExternalStore } from "react";
import { agentInstances, agentTemplates, type AgentInstance, type AgentTemplate, type AgentTemplateInput } from "./agents";
import { SOURCES } from "./source";
import { threads } from "./threads";

export type { AgentInstance, AgentTemplate, AgentTemplateInput };

export { hueFor } from "../components/AgentSwatch";

/** Where a template came from, in words. The format is provenance, not a kind of agent. */
export function provenance(t: Pick<AgentTemplate, "source">): string {
	const scope = t.source.scope ? ` · ${t.source.scope}` : "";
	switch (t.source.format) {
		case "deck": return "Written in the deck";
		case "agent-md": return `NeoPi agent file${scope}`;
		case "watchdog-toml": return `WATCHDOG.toml${scope}`;
		case "chronicler": return "Chronicler settings";
		case "builtin": return "Built into NeoPi";
	}
}

export function isEditable(t: Pick<AgentTemplate, "source">): boolean {
	return t.source.format === "deck";
}

/** Status words and dot tones. Done/cancelled instances keep their history. */
export function statusTone(status: AgentInstance["status"]): "live" | "ok" | "bad" | undefined {
	return status === "running" ? "live" : status === "idle" ? "ok" : status === "failed" ? "bad" : undefined;
}

/* ----------------------------------------------------------- preview half */

const NATIVE_PREVIEW: AgentTemplate[] = [
	{ id: "native:task", name: "task", description: "Takes one assignment, works it, and returns a result to whoever started it.", source: { format: "agent-md", path: "~/.omp/agent/agents/task.md", scope: "bundled" }, preset: "returns a result", model: "@default", tools: ["read", "edit", "bash", "grep", "find"], instanceCount: 0 },
	{ id: "native:scout", name: "scout", description: "Read-only investigation. Maps unfamiliar code and hands back compressed context.", source: { format: "agent-md", path: "~/.omp/agent/agents/scout.md", scope: "bundled" }, preset: "read-only", model: "@smol", tools: ["read", "grep", "find"], instanceCount: 0 },
	{ id: "native:reviewer", name: "reviewer", description: "Reviews a patch for provable defects and returns a verdict.", source: { format: "agent-md", path: ".omp/agents/reviewer.md", scope: "project" }, preset: "read-only", model: "@slow", tools: ["read", "grep"], instanceCount: 0 },
	{ id: "native:advisor-quality", name: "quality", description: "Watches every turn of the session it is attached to and speaks only through advise.", source: { format: "watchdog-toml", path: "~/.omp/agent/WATCHDOG.toml", scope: "user" }, preset: "watches a session", model: "@default", tools: ["advise", "read"], instanceCount: 0 },
	{ id: "native:chronicler", name: "Chronicler", description: "Records decisions and beats of a session as durable notes. One per session.", source: { format: "chronicler" }, preset: "one per session", model: "@smol", tools: ["write"], instanceCount: 0 },
];

const previewInstances: AgentInstance[] = [];
const listeners = new Set<() => void>();
let revision = 0;
function emit(): void { revision++; for (const l of listeners) l(); }
export function useAgentsRevision(): number {
	return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => revision);
}

export interface SpawnInput { templateId: string; label: string; model?: string; task?: string; threadId?: string; parentInstanceId?: string | null }

export interface AgentCatalog {
	templates: AgentTemplate[];
	instances: AgentInstance[];
	/** Errors per half, so one unavailable backend doesn't blank the page. */
	errors: { templates?: string; instances?: string };
}

async function settle<T>(p: Promise<T>): Promise<[T | undefined, string | undefined]> {
	try { return [await p, undefined]; } catch (e) { return [undefined, e instanceof Error ? e.message : String(e)]; }
}

export const agentCatalog = {
	nativeDefinitionsPreview: SOURCES.agentDefinitions === "preview",
	spawnPreview: SOURCES.agentSpawn === "preview",

	async load(): Promise<AgentCatalog> {
		const [[deck, templatesError], [native, instancesError]] = await Promise.all([settle(agentTemplates.list()), settle(agentInstances.list())]);
		const members: AgentInstance[] = threads.previewMembers().map(({ threadId, agent }) => ({
			id: `preview:${threadId}:${agent.id}`,
			templateId: agent.template,
			templateName: agent.name,
			sessionId: threadId,
			threadId,
			parentInstanceId: null,
			label: agent.name,
			status: agent.state === "working" ? "running" : "idle",
			model: agent.model,
			actions: { steer: false, cancel: true, setThinking: false, setFast: false, enter: false },
		}));
		const instances = [...(native ?? []), ...previewInstances, ...members];
		const definitions = [...(deck ?? []), ...(SOURCES.agentDefinitions === "preview" ? NATIVE_PREVIEW : [])];
		const templates = definitions.map((t) => ({ ...t, instanceCount: instances.filter((i) => i.templateId === t.id && (i.status === "running" || i.status === "idle")).length }));
		return { templates, instances, errors: { templates: templatesError, instances: instancesError } };
	},

	save: (input: AgentTemplateInput) => agentTemplates.save(input),
	remove: (id: string) => agentTemplates.remove(id),
	steer: (id: string, text: string) => agentInstances.steer(id, text),
	async cancel(id: string): Promise<void> {
		const member = /^preview:(.+):([^:]+)$/.exec(id);
		if (member && !previewInstances.some((i) => i.id === id)) { await threads.removeAgent(member[1]!, member[2]!); emit(); return; }
		const local = previewInstances.find((i) => i.id === id);
		if (local) { local.status = "cancelled"; local.endedAt = new Date().toISOString(); emit(); return; }
		await agentInstances.cancel(id);
	},

	/**
	 * Start an instance of a template. Preview only: NeoPi has no RPC to
	 * instantiate a definition (neopi#11). The instance is labelled preview
	 * and never touches a real session.
	 */
	async spawn(input: SpawnInput, templates: readonly AgentTemplate[]): Promise<AgentInstance> {
		if (SOURCES.agentSpawn !== "preview") throw new Error("Starting an agent from a template needs NeoPi support that doesn't exist yet (neopi#11).");
		const template = templates.find((t) => t.id === input.templateId);
		const instance: AgentInstance = {
			id: `preview:${crypto.randomUUID()}`,
			templateId: input.templateId,
			templateName: template?.name,
			sessionId: input.threadId ?? `preview:${crypto.randomUUID()}`,
			threadId: input.threadId,
			parentInstanceId: input.parentInstanceId ?? null,
			label: input.label,
			status: "idle",
			model: input.model ?? template?.model,
			task: input.task,
			startedAt: new Date().toISOString(),
			actions: { steer: false, cancel: true, setThinking: false, setFast: false, enter: false },
		};
		previewInstances.push(instance);
		emit();
		return instance;
	},
};

export function isPreviewInstance(i: Pick<AgentInstance, "id">): boolean {
	return i.id.startsWith("preview:");
}
export function isPreviewTemplate(t: Pick<AgentTemplate, "id">): boolean {
	return t.id.startsWith("native:");
}
