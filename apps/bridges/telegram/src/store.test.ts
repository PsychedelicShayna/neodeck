import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { TelegramBridgeStore, type ChatSessionMapping } from "./store.ts";

function mapping(chatId: string, sessionId: string): ChatSessionMapping {
	return { chatId, sessionId, sessionFile: `/isolated/${sessionId}.jsonl`, cwd: "/isolated", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" };
}

test("bindings and defaults survive reopen; reset preserves only that lane's resumable history", () => {
	const dir = mkdtempSync(join(tmpdir(), "deck-telegram-store-"));
	const path = join(dir, "bridge.db");
	let store = new TelegramBridgeStore(path);
	try {
		store.upsert(mapping("-10:1", "first"));
		store.upsert(mapping("-10:42", "topic"));
		store.upsert(mapping("-10:1", "second"));
		store.setProperties("-10:42", { "read-only": true, worktree: "/linked", custom: { nested: [1, 2] } });
		store.close();
		store = new TelegramBridgeStore(path);
		expect(store.get("-10:1")?.sessionId).toBe("second");
		expect(store.get("-10:42")?.sessionFile).toBe("/isolated/topic.jsonl");
		store.delete("-10:1");
		expect(store.get("-10:1")).toBeUndefined();
		expect(store.list("-10:1").map((item) => item.sessionId).sort()).toEqual(["first", "second"]);
		expect(store.list("-10:42").map((item) => item.sessionId)).toEqual(["topic"]);
		store.upsert(store.list("-10:1").find((item) => item.sessionId === "first")!);
		expect(store.get("-10:1")?.sessionId).toBe("first");
		expect(store.getProperties("-10:42")).toEqual({ "read-only": true, worktree: "/linked", custom: { nested: [1, 2] } });
		expect(store.getProperties("-10:1")).toEqual({});
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy DM bindings gain resumable history without changing their session", () => {
	const dir = mkdtempSync(join(tmpdir(), "deck-telegram-legacy-"));
	const path = join(dir, "bridge.db");
	try {
		const db = new Database(path);
		db.exec("CREATE TABLE telegram_chat_sessions (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_file TEXT, cwd TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
		db.prepare("INSERT INTO telegram_chat_sessions VALUES (?, ?, ?, ?, ?, ?)").run("7", "stable", "/stable.jsonl", "/project", "created", "updated");
		db.close();
		const store = new TelegramBridgeStore(path);
		try {
			expect(store.get("7")?.sessionId).toBe("stable");
			store.delete("7");
			expect(store.list("7")[0]?.sessionFile).toBe("/stable.jsonl");
		} finally { store.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
