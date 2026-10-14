import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts";
import { KbService } from "./kb-service.ts";
import { startKbWatcher } from "./kb-watcher.ts";

let root: string;

function put(rel: string, content = `# ${rel}\n`): void {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-kbignore-"));
	put("notes/hub.md", "# Hub\n\nSee [[idea]], [[secret]], [[kept]] and [[tossed]]. needle\n");
	put("drafts/idea.md", "# Idea\n\nneedle\n");
	put("private/secret.md", "# Secret\n\nneedle\n");
	put("notes/private/public-after-all.md", "# Nested private\n");
	put("journal/today.tmp.md", "# Temp\n\nneedle\n");
	put("archive/kept.md", "# Kept\n");
	put("archive/tossed.md", "# Tossed\n\nneedle\n");
	put("node_modules/pkg/readme.md", "# Vendor\n\nneedle\n");
	writeFileSync(
		path.join(root, ".kbignore"),
		[
			"# kb-local exclusions",
			"drafts/",
			"/private",
			"*.tmp.md",
			"archive/**",
			"!archive/kept.md",
			"!node_modules/",
			"",
		].join("\n"),
		"utf8",
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("KbService with .kbignore", () => {
	test("tree hides ignored dirs and files but keeps negated ones", async () => {
		const kb = new KbService({ root });
		const top = await kb.getTree("");
		expect(top?.dirs.map((d) => d.name)).toEqual(["archive", "journal", "notes"]);
		expect((await kb.getTree("archive"))?.files.map((f) => f.name)).toEqual(["kept.md"]);
		expect((await kb.getTree("journal"))?.files).toEqual([]);
		// `/private` is anchored: a nested `private/` is still shown.
		expect((await kb.getTree("notes"))?.dirs.map((d) => d.name)).toEqual(["private"]);
		expect(await kb.getTree("drafts")).toBeUndefined();
		expect(await kb.getTree("private")).toBeUndefined();
		// Skip-set dirs stay hidden even when .kbignore negates them.
		expect(await kb.getTree("node_modules")).toBeUndefined();
		expect(top?.dirs.find((d) => d.name === "notes")?.mdCount).toBe(2);
	});

	test("ignored files are not readable, writable, searchable or graphed", async () => {
		const kb = new KbService({ root });
		expect(await kb.getFile("drafts/idea.md")).toBeUndefined();
		expect(await kb.getFile("journal/today.tmp.md")).toBeUndefined();
		expect(await kb.getFile("archive/kept.md")).toBeDefined();
		expect(await kb.saveFile("drafts/new.md", "# New\n", "create")).toEqual({ kind: "invalid-path" });

		const search = await kb.search("needle", 50);
		expect(search.results.map((r) => r.path)).toEqual(["notes/hub.md"]);

		const graph = await kb.getGraph();
		expect(graph.nodes.map((n) => n.path).sort()).toEqual([
			"archive/kept.md",
			"notes/hub.md",
			"notes/private/public-after-all.md",
		]);
		expect(graph.edges).toEqual([{ source: "notes/hub.md", target: "archive/kept.md" }]);
		const hub = await kb.getFile("notes/hub.md");
		expect(hub?.outgoingLinks.filter((l) => l.resolved).map((l) => l.target)).toEqual(["kept"]);
	});

	test("an edited .kbignore applies after the index is invalidated", async () => {
		const kb = new KbService({ root });
		expect((await kb.getTree(""))?.dirs.map((d) => d.name)).not.toContain("drafts");
		writeFileSync(path.join(root, ".kbignore"), "journal/\n", "utf8");
		kb.invalidate();
		const names = (await kb.getTree(""))?.dirs.map((d) => d.name);
		expect(names).toEqual(["archive", "drafts", "notes", "private"]);
		expect((await kb.search("needle", 50)).results.map((r) => r.path)).toContain("drafts/idea.md");
	});

	test("the watcher ignores excluded paths and reloads on .kbignore edits", async () => {
		const prev = process.env.NPI_DECK_WATCH_KB;
		delete process.env.NPI_DECK_WATCH_KB;
		const kb = new KbService({ root });
		await kb.ensureIndex();
		const frames: BroadcastFrame[] = [];
		const unsubscribe = broadcastBus.subscribe((f) => {
			if (f.type === "kb_changed") frames.push(f);
		});
		const dispose = startKbWatcher(kb);
		const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 700));
		try {
			await settle();
			frames.length = 0;
			put("drafts/another.md");
			put("private/more.md");
			put("node_modules/pkg/other.md");
			await settle();
			expect(frames).toHaveLength(0);

			writeFileSync(path.join(root, ".kbignore"), "", "utf8");
			await settle();
			expect(frames.length).toBeGreaterThan(0);
			expect((await kb.getTree(""))?.dirs.map((d) => d.name)).toContain("drafts");

			frames.length = 0;
			put("drafts/third.md");
			await settle();
			expect(frames.length).toBeGreaterThan(0);
		} finally {
			dispose();
			unsubscribe();
			if (prev === undefined) delete process.env.NPI_DECK_WATCH_KB;
			else process.env.NPI_DECK_WATCH_KB = prev;
		}
	});

	test("NPI_DECK_KB_EXCLUDE_DIRS still applies alongside .kbignore", async () => {
		const script = `
			import { KbService } from ${JSON.stringify(path.join(import.meta.dir, "kb-service.ts"))};
			const kb = new KbService({ root: ${JSON.stringify(root)} });
			const tree = await kb.getTree("");
			console.log(JSON.stringify(tree.dirs.map((d) => d.name)));
		`;
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			env: { ...process.env, NPI_DECK_KB_EXCLUDE_DIRS: "notes, journal" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual(["archive"]);
	});
});

describe("KbService orphan census", () => {
	test("lists indexed notes nothing else links to; ignored notes and self-links do not count", async () => {
		// drafts/ is ignored, so its link cannot rescue public-after-all, and
		// public-after-all's link to itself is not a backlink.
		put("drafts/idea.md", "# Idea\n\n[[public-after-all]]\n");
		put("notes/private/public-after-all.md", "# Nested\n\n[[public-after-all]] and [[missing-note]]\n");
		const census = await new KbService({ root }).getOrphanCensus();
		expect(census.root).toBe(path.resolve(root));
		expect(census.notes).toBe(3);
		expect(census.orphans).toEqual([
			{ path: "notes/hub.md", title: "hub", outbound: 1 },
			{ path: "notes/private/public-after-all.md", title: "public-after-all", outbound: 0 },
		]);
		// hub → idea, secret, tossed (all ignored) plus public-after-all → missing-note.
		expect(census.unresolvedLinks).toBe(4);
	});
});

describe("KbService literal full-text search", () => {
	test("different warm queries preserve literal hits, snippets, scores and metadata", async () => {
		put("notes/alpha.md", "---\nname: Human heading\ntags: [topic]\n---\nxxMiXeD::needleYY mixed::needle\n");
		put("notes/beta.md", "# Other\nOnly second/pattern appears here.\n");
		// All query trigrams occur, but not in the query's order.
		put("notes/decoy.md", "# Decoy\nmix ixe xed ed: d:: ::n :ne nee eed edl dle\n");
		const kb = new KbService({ root });
		await kb.getBacklinks("notes/alpha.md");
		const first = await kb.search("mixed::needle", 50);
		expect(first.results).toHaveLength(1);
		expect(first.results[0]).toMatchObject({
			path: "notes/alpha.md", title: "Human heading", score: 11, matchKind: "body",
		});
		expect(first.results[0]?.snippet).toContain("MiXeD::needle");
		const second = await kb.search("second/pattern", 50);
		expect(second.results.map((r) => r.path)).toEqual(["notes/beta.md"]);
		expect(second.results[0]?.snippet).toContain("second/pattern");
		expect((await kb.search("human heading", 50)).results[0]).toMatchObject({
			path: "notes/alpha.md", title: "Human heading", score: 70, matchKind: "title",
		});
		expect((await kb.search("topic", 50)).results[0]).toMatchObject({
			path: "notes/alpha.md", score: 60, matchKind: "tag",
		});
		expect((await kb.search("alpha", 50)).results[0]).toMatchObject({
			path: "notes/alpha.md", score: 100, matchKind: "stem",
		});
	});

	test("short, Unicode and repeated substrings keep literal occurrence semantics", async () => {
		put("notes/literals.md", "§§§ Ω😀 punctuation/@! " + "zz ".repeat(25));
		const kb = new KbService({ root });
		for (const [query, score] of [["§", 12], ["§§", 10], ["Ω😀", 10], ["/@!", 10], ["zz", 30]] as const) {
			const response = await kb.search(query, 50);
			expect(response.results).toHaveLength(1);
			expect(response.results[0]).toMatchObject({ path: "notes/literals.md", matchKind: "body", score });
			expect(response.results[0]?.snippet).toContain(query);
		}
		expect((await kb.search("not-present-anywhere", 50)).totalMatches).toBe(0);
	});

	test("invalidation refreshes body hits and reverse edges across concurrent cold readers", async () => {
		put("notes/source.md", "Old-unique marker [[kept]]\n");
		const kb = new KbService({ root });
		const pending = kb.search("old-unique", 50);
		put("notes/source.md", "New-unique marker [[hub]]\n");
		kb.invalidate();
		const [oldHits, newHits, backlinks] = await Promise.all([
			pending, kb.search("new-unique", 50), kb.getBacklinks("notes/hub.md"),
		]);
		expect(oldHits.totalMatches).toBe(0);
		expect(newHits.results.map((r) => r.path)).toEqual(["notes/source.md"]);
		expect(backlinks?.backlinks.map((b) => b.source)).toEqual(["notes/source.md"]);
		put("notes/source.md", "Replacement marker [[kept]]\n");
		kb.invalidate();
		expect((await kb.search("new-unique", 50)).totalMatches).toBe(0);
		expect((await kb.search("replacement marker", 50)).results.map((r) => r.path)).toEqual(["notes/source.md"]);
		expect((await kb.getBacklinks("notes/hub.md"))?.backlinks).toEqual([]);
		expect((await kb.getBacklinks("archive/kept.md"))?.backlinks.map((b) => b.source).sort()).toEqual(["notes/hub.md", "notes/source.md"]);
	});
});
