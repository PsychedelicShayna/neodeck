import { open, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const schema = { type: "object" as const, properties: { path: { type: "string" as const }, query: { type: "string" as const } }, required: ["path"], additionalProperties: false };

/** Pure filesystem reads: no URI handlers, shell, evaluator, plugins, or subprocesses. */
export function cardReadTools(cwd: string): CustomTool[] {
	async function target(input: unknown): Promise<string> {
		if (typeof input !== "string") throw new Error("path must be a string");
		const root = await realpath(cwd);
		const file = await realpath(path.resolve(root, input));
		if (file !== root && !file.startsWith(root + path.sep)) throw new Error("path is outside this card worktree");
		return file;
	}
	async function readBounded(file: string): Promise<string> {
		const handle = await open(file, "r");
		try {
			if (!(await handle.stat()).isFile()) throw new Error("not a regular file");
			const buffer = Buffer.alloc(1024 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally { await handle.close(); }
	}
	return [
		{
			name: "card_read", label: "Read card worktree", description: "Read a local file (up to 1 MiB) or list a directory in this card worktree. No URLs or code execution.", parameters: schema,
			approval: "read",
			async execute(_id, params: { path: string }) {
				const file = await target(params.path);
				return text((await stat(file)).isDirectory() ? (await readdir(file)).sort().join("\n") : await readBounded(file));
			},
		},
		{
			name: "card_search", label: "Search card worktree", description: "Search regular files recursively for literal text. Symlinks are not followed; at most 5000 files and 200 matches.", parameters: { ...schema, required: ["path", "query"] },
			approval: "read",
			async execute(_id, params: { path: string; query: string }) {
				if (typeof params.query !== "string" || !params.query) throw new Error("query must be nonempty literal text");
				const root = await target(params.path);
				const lines: string[] = [];
				let count = 0;
				async function scan(file: string): Promise<void> {
					if (count >= 5000 || lines.length >= 200) return;
					if ((await stat(file)).isDirectory()) {
						for (const entry of await readdir(file, { withFileTypes: true })) {
							if (entry.isSymbolicLink() || entry.name === ".git") continue;
							if (entry.isDirectory() || entry.isFile()) await scan(path.join(file, entry.name));
						}
						return;
					}
					count++;
					const content = await readBounded(file);
					for (const [index, line] of content.split("\n").entries()) {
						if (line.includes(params.query)) lines.push(`${path.relative(cwd, file)}:${index + 1}:${line.slice(0, 1000)}`);
						if (lines.length >= 200) break;
					}
				}
				await scan(root);
				return text(lines.join("\n"));
			},
		},
	];
}
