import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

// Deliberately standalone: the child CLI neither opens the vault nor derives write identity.
// Only the deck's authenticated server capability decides project/read-only authority.
export function createKbAgentTools(endpoint: string, token: string): ToolDefinition[] {
	const properties = {
		read: { operation: { type: "string", enum: ["open", "links", "backlinks", "search"] }, path: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
		write: { path: { type: "string" }, content: { type: "string" }, mode: { type: "string", enum: ["create", "update"] }, kind: { type: "string", enum: ["note", "edge"] }, captureId: { type: "string" } },
	};
	return (["read", "write"] as const).map(operation => ({
			name: `kb_${operation}`, label: `KB ${operation}`,
			description: operation === "read" ? "Only on explicit request: open KB node, links/backlinks, or search entry metadata. Never fetch ambient context." : "Write scoped project knowledge or explicitly capture inbox content. Authority is enforced by the server.",
			approval: operation,
			parameters: { type: "object", properties: properties[operation], required: operation === "read" ? ["operation"] : ["path", "mode", "kind"], additionalProperties: false },
			async execute(_id: string, args: unknown, signal?: AbortSignal) {
				const response = await fetch(`${endpoint}/${operation}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal });
				const text = await response.text();
				if (!response.ok) throw new Error(`KB ${operation} refused (${response.status}): ${text}`);
				return { content: [{ type: "text", text }], details: {} };
			},
		} as unknown as ToolDefinition));
}

export default function kbExtension(pi: ExtensionAPI): void {
	const endpoint = process.env.NPI_DECK_KB_API_URL;
	const token = process.env.NPI_DECK_KB_TOKEN;
	if (endpoint && token) for (const tool of createKbAgentTools(endpoint, token)) pi.registerTool(tool);
}
