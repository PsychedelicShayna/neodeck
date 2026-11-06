/**
 * Which adapter each domain uses. `live` talks to the deck's existing
 * endpoints; `preview` serves in-memory fixtures so a page is fully
 * interactive before its backend exists. A page whose data is preview shows
 * the `preview data` chip. The endpoints preview stands in for are specified
 * in docs/design/backend-contracts.md.
 */
export type Source = "live" | "preview";

export type Domain =
	| "auth"
	| "accounts"
	| "inbox"
	| "classifier"
	| "classifierInference"
	| "board"
	| "boardEvidence"
	| "threads"
	| "threadAgents"
	| "models"
	| "dictation"
	| "agents"
	| "agentTemplates"
	| "agentInstances"
	| "agentDefinitions"
	| "agentSpawn"
	| "judge"
	| "studio"
	| "studioGraphs"
	| "studioRouters"
	| "knowledge"
	| "knowledgeHistory"
	| "skills"
	| "skillsUsage"
	| "github"
	| "usage"
	| "providers"
	| "settings"
	| "env"
	| "npiConfig"
	| "integrations";

export const SOURCES: Readonly<Record<Domain, Source>> = {
	auth: "preview",
	accounts: "preview",
	inbox: "live",
	/** Manual proposal, durable board filing, routing and delivery history. Model inference is unavailable. */
	classifier: "live",
	/** Model-backed suggestions need a native tool-free structured-inference adapter. */
	classifierInference: "preview",
	/** Cards, columns, moves, assignment: the deck's tasks API. */
	board: "live",
	/** Durable card receipts, frontmatter provenance and linked work. */
	boardEvidence: "live",
	/** Sessions and transcripts: the deck's websocket store. */
	threads: "live",
	/** Equal-participant creation and broadcast wait for NeoPi's hierarchy design. */
	threadAgents: "preview",
	/** The model catalogue behind the picker: `/api/models` plus role mapping. */
	models: "live",
	dictation: "preview",
	agents: "preview",
	/** Deck-authored definitions only; native definition discovery is unavailable. */
	agentTemplates: "live",
	/** Native identities and permitted actions, without preview instances. */
	agentInstances: "live",
	/** NeoPi's own definitions (.omp/agents, WATCHDOG.toml, Chronicler): needs `list_agent_definitions`. */
	agentDefinitions: "preview",
	/** Starting an instance from a template: needs the neopi#11 flat agent model. */
	agentSpawn: "preview",
	judge: "preview",
	/** Flows are routines: `/api/routines` and the native graph. */
	studio: "live",
	/** Authored pipelines, classifiers and board flows: `/api/graphs`. */
	studioGraphs: "live",
	/** Router designs stay browser-local until NeoProxy owns their save API. */
	studioRouters: "preview",
	knowledge: "live",
	knowledgeHistory: "live",
	skills: "live",
	skillsUsage: "preview",
	/** Read-only GitHub CLI queries; GitHub App installation remains preview. */
	github: "live",
	usage: "preview",
	providers: "preview",
	/** Engine, workspaces, notifications, appearance: existing settings endpoints. */
	settings: "live",
	/** Managed environment: `/api/settings/env`. */
	env: "live",
	/** The raw NeoPi config: `/api/npi-config`. */
	npiConfig: "live",
	/** MCP servers and bridges: existing endpoints. GitHub app is preview. */
	integrations: "live",
};

export function isPreview(...domains: Domain[]): boolean {
	return domains.some((d) => SOURCES[d] === "preview");
}
