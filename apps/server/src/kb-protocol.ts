import path from "node:path";
import type { InternalResource, InternalUrl, ProtocolHandler, SchemeSpec } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { workflowKb } from "./kb-workflows.ts";

/** Explicit read-only vault access; the same guards, exclusions and index as the cockpit. */
export class KbProtocolHandler implements ProtocolHandler {
	readonly scheme = "kb";
	readonly spec: SchemeSpec = { backing: "file", selectors: "lines", immutable: true };
	async resolve(url: InternalUrl): Promise<InternalResource> {
		const kb = workflowKb();
		if (!(await kb.getStatus()).exists) throw new Error("kb:// unavailable: set NPI_DECK_KB_ROOT to your vault");
		const host = url.rawHost || url.hostname;
		const pathname = url.rawPathname ?? url.pathname;
		const combined = host ? `${host}${pathname === "/" ? "" : pathname}` : pathname.replace(/^\//, "");
		const relative = decodeURIComponent(combined.replaceAll("\\", "/"));
		if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.split("/").some(p => p === "." || p === "..")) {
			throw new Error("kb:// path contains traversal or an absolute path");
		}
		const clean = relative.replace(/\/$/, "");
		const notePath = path.extname(clean) ? clean : `${clean}.md`;
		if (clean && !pathname.endsWith("/")) {
			const note = await kb.getFile(notePath);
			if (note) return { url: url.href, content: note.rawContent, contentType: "text/markdown", size: note.size, sourcePath: note.absolutePath };
		}
		const tree = await kb.getTree(clean);
		if (!tree) throw new Error(`kb resource not found or excluded: ${clean} (also tried .md suffix)`);
		const prefix = clean ? `${clean}/` : "";
		const content = [`# kb://${prefix}`, "", ...tree.dirs.map(d => `- [${d.name}/](kb://${d.path}/)`), ...tree.files.map(f => `- [${f.name}](kb://${f.path})`)].join("\n");
		return { url: url.href, content, contentType: "text/markdown", size: Buffer.byteLength(content), sourcePath: path.join(kb.root, clean) };
	}
}
