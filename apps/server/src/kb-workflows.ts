import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { KbService, resolveKbRoot } from "./kb-service.ts";
import { getInbox, updateInbox } from "./db/inbox.ts";

import { createKbAgentTools } from "./kb-cli-extension.ts";
export interface KbAgentIdentity {
	agentId: string;
	/** Trusted session/card project cwd, never a request parameter or linked worktree. */
	projectCwd: string | null;
	readOnly: boolean;
}
export interface KbReadRequest {
	operation: "open" | "links" | "backlinks" | "search";
	path?: string;
	query?: string;
	limit?: number;
}
export interface KbWriteRequest {
	path: string;
	content?: string;
	mode: "create" | "update";
	kind: "note" | "edge";
	captureId?: string;
}
let configured: KbService | undefined;
export function workflowKb(): KbService {
	const root = path.resolve(resolveKbRoot());
	if (!configured || configured.root !== root) configured = new KbService({ root });
	return configured;
}

/** A worktree's common git directory names the owning project, not its checkout name. */
export async function kbProject(cwd: string | null): Promise<string | undefined> {
	if (!cwd) return undefined;
	let dir = await realpath(cwd);
	for (;;) {
		const marker = path.join(dir, ".git");
		try {
			const st = await lstat(marker);
			let gitDir = marker;
			if (st.isFile()) {
				const match = /^gitdir: (.+)\s*$/m.exec(await readFile(marker, "utf8"));
				if (!match) return undefined;
				gitDir = path.resolve(dir, match[1]!.trim());
			}
			try { gitDir = path.resolve(gitDir, (await readFile(path.join(gitDir, "commondir"), "utf8")).trim()); }
			catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
			const canonical = await realpath(gitDir);
			const project = path.basename(path.dirname(canonical)).toLowerCase();
			return /^[a-z0-9][a-z0-9_-]*$/.test(project) ? project : undefined;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export async function readKb(service: KbService, request: KbReadRequest): Promise<unknown> {
	if (request.operation === "search") return service.search(request.query ?? "", request.limit ?? 20, true);
	if (typeof request.path !== "string" || !request.path) throw new Error("KB path required");
	const notePath = request.path.replace(/^kb:\/\//, "");
	const target = notePath.toLowerCase().endsWith(".md") ? notePath : `${notePath}.md`;
	let result: unknown;
	switch (request.operation) {
		case "open": result = await service.getFile(target); break;
		case "links": result = await service.getLinks(target); break;
		case "backlinks": result = await service.getBacklinks(target); break;
		default: throw new Error("Unknown KB operation");
	}
	if (!result) throw new Error("KB note not found or excluded");
	return result;
}

/** Reject aliases, including symlinks within the vault and case-only directory names. */
async function checkWritePath(root: string, relative: string): Promise<void> {
	if (relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative)) throw new Error("Invalid KB path");
	const parts = relative.split("/");
	if (parts.some(p => !p || p === "." || p === "..") || !relative.endsWith(".md")) throw new Error("Invalid KB path");
	let parent = path.resolve(root);
	try { parent = await realpath(root); }
	catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
	for (const part of parts) {
		try {
			const names = await readdir(parent);
			if (names.some(name => name.toLowerCase() === part.toLowerCase() && name !== part)) throw new Error("Case alias forbidden");
			const child = path.join(parent, part);
			const st = await lstat(child);
			if (st.isSymbolicLink()) throw new Error("KB writes cannot follow symlinks");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		parent = path.join(parent, part);
	}
}

export async function writeKb(service: KbService, identity: KbAgentIdentity, request: KbWriteRequest): Promise<unknown> {
	if (!identity.agentId || identity.readOnly) throw new Error("KB write forbidden for this agent");
	const project = await kbProject(identity.projectCwd);
	if (!project) throw new Error("KB write requires an authenticated project session");
	if (typeof request.path !== "string") throw new Error("KB path required");
	await checkWritePath(service.root, request.path);
	const parts = request.path.split("/");
	const own = parts[0] === "projects" && parts[1] === project && parts.length >= 3;
	const neighbour = parts[0] === "projects" && /^[a-z0-9][a-z0-9_-]*$/.test(parts[1] ?? "") &&
		parts[1] !== project && parts[2] === "edges" && parts[3] === project && parts.length === 5;
	if (!own && !(neighbour && request.kind === "edge")) throw new Error("KB write outside project authority");
	if (request.kind !== "note" && request.kind !== "edge") throw new Error("KB write kind required");
	if (request.mode !== "create" && request.mode !== "update") throw new Error("KB write mode required");
	let content = request.content;
	const capture = request.captureId ? getInbox(request.captureId) : undefined;
	if (request.captureId && !capture) throw new Error("Capture not found");
	if (capture) content = `# ${capture.title}\n\n${capture.body}\n\n_Captured from inbox ${capture.id} (${capture.kind})_\n`;
	if (typeof content !== "string") throw new Error("KB content required");
	if (neighbour && !new RegExp(`\\[\\[projects/${project}/[^\\]\\n]+\\]\\]`).test(content)) {
		throw new Error("Neighbour edge must link back to the owning project note");
	}
	const saved = await service.saveFile(request.path, content, request.mode);
	if (saved.kind !== "ok") throw new Error(`KB save refused: ${saved.kind}`);
	if (capture) updateInbox(capture.id, { processed: true });
	return saved.response;
}

/** No call and no explicit paths means no vault read and an unchanged prompt. */
export async function kbPrompt(prompt: string, paths?: string[], service = workflowKb()): Promise<string> {
	if (!paths?.length) return prompt;
	for (const notePath of paths) {
		const note = await readKb(service, { operation: "open", path: notePath }) as { path: string; rawContent: string };
		prompt += `\n\n<requested-kb-context path=${JSON.stringify(note.path)}>\n${note.rawContent}\n</requested-kb-context>`;
	}
	return prompt;
}

export function kbTools(identity: () => KbAgentIdentity, service = workflowKb()): ToolDefinition[] {
	return createKbAgentTools("", "").map(tool => ({
		...tool,
		execute: async (_id: string, args: unknown) => ({
			content: [{ type: "text", text: JSON.stringify(tool.name === "kb_read"
				? await readKb(service, args as KbReadRequest)
				: await writeKb(service, identity(), args as KbWriteRequest)) }],
			details: {},
		}),
	})) as ToolDefinition[];
}
