import * as path from "node:path";

import { loadConfig, parseInt10 } from "../../../server/src/config.ts";
import { getDataDir, loadManagedEnvIntoProcess } from "../../../server/src/env-store.ts";

export interface TelegramBridgeConfig {
	botToken: string;
	allowedUserIds: Set<string>;
	allowedChatIds: Set<string>;
	requireMention: boolean;
	mentionPatterns: RegExp[];
	freeResponseChatIds: Set<string>;
	freeResponseTopics: Set<string>;
	allowedTopics: Set<string>;
	ignoredTopics: Set<string>;
	deckApiBase: string;
	deckWsUrl: string;
	defaultCwd: string;
	dbPath: string;
	pollTimeoutSeconds: number;
	editIntervalMs: number;
}

export function loadTelegramBridgeConfig(): TelegramBridgeConfig {
	loadManagedEnvIntoProcess();
	const deck = loadConfig();
	const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

	const allowedUserIds = parseAllowedUsers(process.env.TELEGRAM_ALLOWED_USERS);
	if (allowedUserIds.size === 0) {
		throw new Error("TELEGRAM_ALLOWED_USERS must contain at least one numeric Telegram user id");
	}

	const deckApiBase = normalizeBaseUrl(process.env.NPI_DECK_API_BASE?.trim() || `http://127.0.0.1:${deck.port}`);
	const deckWsUrl = toWsUrl(deckApiBase);
	const dbPath = path.resolve(process.env.TELEGRAM_BRIDGE_DB_PATH?.trim() || path.join(getDataDir(), "telegram-bridge.db"));

	return {
		botToken,
		allowedUserIds,
		allowedChatIds: parseAllowedChats(process.env.TELEGRAM_GROUP_ALLOWED_CHATS),
		requireMention: !["0", "false", "no", "off"].includes(process.env.TELEGRAM_REQUIRE_MENTION?.trim().toLowerCase() ?? ""),
		mentionPatterns: parseMentionPatterns(process.env.TELEGRAM_MENTION_PATTERNS),
		freeResponseChatIds: parseAllowedChats(process.env.TELEGRAM_FREE_RESPONSE_CHATS, "TELEGRAM_FREE_RESPONSE_CHATS"),
		freeResponseTopics: parseTopics(process.env.TELEGRAM_FREE_RESPONSE_TOPICS, true),
		allowedTopics: parseTopics(process.env.TELEGRAM_ALLOWED_TOPICS),
		ignoredTopics: parseTopics(process.env.TELEGRAM_IGNORED_THREADS),
		deckApiBase,
		deckWsUrl,
		defaultCwd: deck.defaultCwd,
		dbPath,
		pollTimeoutSeconds: clamp(parseInt10(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS, 30), 1, 50),
		editIntervalMs: clamp(parseInt10(process.env.TELEGRAM_EDIT_INTERVAL_MS, 700), 250, 5000),
	};
}

function parseAllowedUsers(raw: string | undefined): Set<string> {
	const out = new Set<string>();
	if (!raw) return out;
	for (const part of raw.split(/[\s,]+/)) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		if (!/^\d+$/.test(trimmed)) throw new Error(`TELEGRAM_ALLOWED_USERS contains a non-numeric id: ${trimmed}`);
		out.add(trimmed);
	}
	return out;
}

export function parseAllowedChats(raw: string | undefined, key = "TELEGRAM_GROUP_ALLOWED_CHATS"): Set<string> {
	const values = raw?.split(/[\s,]+/).filter(Boolean) ?? [];
	if (values.some((value) => !/^-\d+$/.test(value))) throw new Error(`${key} requires negative numeric chat IDs.`);
	return new Set(values);
}

export function parseTopics(raw: string | undefined, scopedOnly = false): Set<string> {
	const values = raw?.split(/[\s,]+/).filter(Boolean) ?? [];
	const pattern = scopedOnly ? /^-\d+:[1-9]\d*$/ : /^(?:-\d+:)?[1-9]\d*$/;
	if (values.some((value) => !pattern.test(value))) throw new Error("Telegram topics require positive topic IDs or negative-chat-ID:topic-ID pairs; free-response topics require pairs.");
	return new Set(values);
}

export function parseMentionPatterns(raw: string | undefined): RegExp[] {
	if (!raw?.trim()) return [];
	let values: unknown;
	try { values = JSON.parse(raw); }
	catch { values = raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean); }
	if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) throw new Error("TELEGRAM_MENTION_PATTERNS requires nonempty regex strings.");
	try { return values.map((value: string) => new RegExp(value, "iu")); }
	catch { throw new Error("TELEGRAM_MENTION_PATTERNS contains an invalid regex."); }
}

function normalizeBaseUrl(raw: string): string {
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`NPI_DECK_API_BASE must be http or https, got ${url.protocol}`);
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function toWsUrl(httpBase: string): string {
	const url = new URL(httpBase);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/ws";
	return url.toString();
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}
