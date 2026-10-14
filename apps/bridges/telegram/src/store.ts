import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ChatSessionMapping {
	chatId: string;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
}

interface MappingRow {
	chat_id: string;
	session_id: string;
	session_file: string | null;
	cwd: string;
	created_at: string;
	updated_at: string;
}

export class TelegramBridgeStore {
	private readonly db: Database;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath, { create: true, strict: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS telegram_chat_sessions (
				chat_id      TEXT PRIMARY KEY,
				session_id   TEXT NOT NULL,
				session_file TEXT,
				cwd          TEXT NOT NULL,
				created_at   TEXT NOT NULL,
				updated_at   TEXT NOT NULL
			)
		`);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS telegram_session_history (
				chat_id TEXT NOT NULL, session_id TEXT NOT NULL, session_file TEXT,
				cwd TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				PRIMARY KEY (chat_id, session_id)
			);
			INSERT OR IGNORE INTO telegram_session_history SELECT * FROM telegram_chat_sessions;
			CREATE TABLE IF NOT EXISTS telegram_card_defaults (chat_id TEXT PRIMARY KEY, properties TEXT NOT NULL);
		`);
	}

	get(chatId: string): ChatSessionMapping | undefined {
		const row = this.db
			.query<MappingRow, [string]>(
				"SELECT chat_id, session_id, session_file, cwd, created_at, updated_at FROM telegram_chat_sessions WHERE chat_id = ?",
			)
			.get(chatId);
		return row ? fromRow(row) : undefined;
	}

	upsert(mapping: ChatSessionMapping): void {
		this.db
			.prepare<unknown, [string, string, string | null, string, string, string]>(
				`INSERT INTO telegram_chat_sessions (chat_id, session_id, session_file, cwd, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(chat_id) DO UPDATE SET
				   session_id = excluded.session_id,
				   session_file = excluded.session_file,
				   cwd = excluded.cwd,
				   updated_at = excluded.updated_at`,
			)
			.run(
				mapping.chatId,
				mapping.sessionId,
				mapping.sessionFile ?? null,
				mapping.cwd,
				mapping.createdAt,
				mapping.updatedAt,
			);
		this.db.prepare(`INSERT INTO telegram_session_history VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(chat_id, session_id) DO UPDATE SET session_file = excluded.session_file, updated_at = excluded.updated_at`)
			.run(mapping.chatId, mapping.sessionId, mapping.sessionFile ?? null, mapping.cwd, mapping.createdAt, mapping.updatedAt);
	}

	delete(chatId: string): void {
		this.db.prepare<unknown, [string]>("DELETE FROM telegram_chat_sessions WHERE chat_id = ?").run(chatId);
	}

	list(chatId: string): ChatSessionMapping[] {
		return this.db.query<MappingRow, [string]>("SELECT * FROM telegram_session_history WHERE chat_id = ? ORDER BY updated_at DESC")
			.all(chatId).map(fromRow);
	}

	getProperties(chatId: string): Record<string, unknown> {
		const row = this.db.query<{ properties: string }, [string]>("SELECT properties FROM telegram_card_defaults WHERE chat_id = ?").get(chatId);
		return row ? JSON.parse(row.properties) as Record<string, unknown> : {};
	}

	setProperties(chatId: string, properties: Record<string, unknown>): void {
		this.db.prepare("INSERT INTO telegram_card_defaults VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET properties = excluded.properties")
			.run(chatId, JSON.stringify(properties));
	}

	close(): void {
		this.db.close();
	}
}

export function nowIso(): string {
	return new Date().toISOString();
}

function fromRow(row: MappingRow): ChatSessionMapping {
	return {
		chatId: row.chat_id,
		sessionId: row.session_id,
		...(row.session_file ? { sessionFile: row.session_file } : {}),
		cwd: row.cwd,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
