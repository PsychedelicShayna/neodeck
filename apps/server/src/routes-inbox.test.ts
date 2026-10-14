/**
 * Promoting an inbox item files a task, so an open kanban in another tab must
 * hear about it the same way it hears about a card created via `/tasks`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PromoteInboxItemResponse } from "@npi-deck/protocol";

import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts";
import { createInbox } from "./db/inbox.ts";
import { closeDb, openDb } from "./db/index.ts";
import { buildInboxRouter } from "./routes-inbox.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows SQLite handle release can lag slightly after close().
		}
		dbDir = null;
	}
});

function boot() {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "npi-deck-inbox-route-"));
	openDb({ path: path.join(dbDir, "deck.db") });
	return buildInboxRouter();
}

describe("POST /inbox/:id/promote", () => {
	test("publishes tasks_changed once the task is filed", async () => {
		const app = boot();
		const item = createInbox({ kind: "idea", title: "Board should see me" });
		const frames: BroadcastFrame[] = [];
		const unsubscribe = broadcastBus.subscribe((f) => frames.push(f));
		let res: Response;
		try {
			res = await app.request(`/inbox/${item.id}/promote`, { method: "POST" });
		} finally {
			unsubscribe();
		}
		expect(res.status).toBe(201);
		const body = (await res.json()) as PromoteInboxItemResponse;
		expect(body.task.title).toBe("Board should see me");
		expect(frames.filter((f) => f.type === "tasks_changed")).toHaveLength(1);
	});
	test("preserves card front matter and explicit project assignment on promotion", async () => {
		const app = boot();
		const metadata = "---\nread-only: true\nworktree: /linked\nmodel: provider/model\nrole: research\ncustom:\n  owner: Captain\n---\n\nInvestigate routing";
		const item = createInbox({ kind: "ticket", title: "Routing", body: metadata, source: "telegram:-10:42:7" });
		const res = await app.request(`/inbox/${item.id}/promote`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/project" }),
		});
		expect(res.status).toBe(201);
		const body = await res.json() as PromoteInboxItemResponse;
		expect(body.task.cwd).toBe("/project");
		expect(body.task.body.startsWith(`${metadata}\n\n---\n_Promoted from inbox`)).toBe(true);
		expect(body.inbox.processedAt).toBeDefined();
		expect(body.inbox.source).toBe("telegram:-10:42:7");
	});

	test("rejects invalid project assignment before creating a card or processing the inbox", async () => {
		const app = boot();
		const item = createInbox({ kind: "ticket", title: "Retain on failure" });
		const res = await app.request(`/inbox/${item.id}/promote`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: 17 }),
		});
		expect(res.status).toBe(400);
		const stored = await (await app.request(`/inbox/${item.id}`)).json() as { processedAt?: string };
		expect(stored.processedAt).toBeUndefined();
	});
});
