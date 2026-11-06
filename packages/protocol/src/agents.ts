/** Definitions describe configuration. Only instances have lifecycle state. */
export interface AgentTemplate {
	id: string;
	name: string;
	description?: string;
	source: { format: "agent-md" | "watchdog-toml" | "chronicler" | "builtin" | "deck"; path?: string; scope?: "user" | "project" | "bundled" };
	/** Native selector, kept opaque. A model role is not a template. */
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPrompt?: string;
	/** Informational preset label, never an instance type or hierarchy. */
	preset?: string;
	instanceCount: number;
	createdAt?: string;
	updatedAt?: string;
}
export type AgentTemplateInput = Pick<AgentTemplate, "id" | "name" | "description" | "model" | "thinking" | "tools" | "systemPrompt" | "preset">;

export interface AgentInstance {
	id: string;
	templateId: string | null;
	templateName?: string;
	sessionId: string;
	threadId?: string;
	/** NeoPi's journal identity, if the runtime exposes it. */
	sessionFile?: string;
	parentInstanceId: string | null;
	label: string;
	status: "running" | "idle" | "done" | "failed" | "cancelled";
	model?: string;
	thinking?: string;
	task?: string;
	startedAt?: string;
	endedAt?: string;
	observes?: boolean;
	actions: { steer: boolean; cancel: boolean; setThinking: boolean; setFast: boolean; enter: boolean };
}

export interface AgentCapabilities {
	templates: boolean;
	nativeDefinitions: boolean;
	instances: boolean;
	spawn: boolean;
	restrictions: boolean;
	judge: boolean;
	reason: string;
}
