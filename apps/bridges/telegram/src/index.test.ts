import { describe, expect, test } from "bun:test";
import type { SessionSummary, Task } from "@npi-deck/protocol";
import { TelegramBridge } from "./index.ts";
import { DeckClient } from "./deck.ts";
import { TelegramApi, type TelegramMessage } from "./telegram.ts";
import { TelegramBridgeStore } from "./store.ts";
import type { TelegramBridgeConfig } from "./config.ts";
import { parseProperties, type IntakeCard } from "./commands.ts";

const config: TelegramBridgeConfig = {
	botToken: "offline", allowedUserIds: new Set(["7"]), allowedChatIds: new Set(["-10"]), requireMention: true,
	mentionPatterns: [], freeResponseChatIds: new Set(), freeResponseTopics: new Set(), allowedTopics: new Set(), ignoredTopics: new Set(),
	deckApiBase: "http://127.0.0.1:1", deckWsUrl: "ws://127.0.0.1:1/ws", dbPath: ":memory:", defaultCwd: "/project", pollTimeoutSeconds: 1, editIntervalMs: 250,
};
const message: TelegramMessage = { message_id: 1, chat: { id: -10, type: "supergroup", is_forum: true }, is_topic_message: true, message_thread_id: 42, from: { id: 7 } };

function harness(policy: TelegramBridgeConfig = config) {
	const events: string[] = [];
	const replies: string[] = [];
	const typingThreads: (number | undefined)[] = [];
	const filedCards: IntakeCard[] = [];
	let downloads = 0;
	let promptError = false;
	class Transport extends TelegramApi {
		override async sendMessage(chatId: number | string, text: string) {
			events.push("reply"); replies.push(text);
			return { message_id: replies.length, chat: { id: Number(chatId) } };
		}
		override async editMessageText(chatId: number | string, messageId: number, text: string) {
			replies.push(text);
			return { message_id: messageId, chat: { id: Number(chatId) } };
		}
		override async sendTyping(_chatId: number | string, thread?: { message_thread_id?: number }) {
			events.push("typing"); typingThreads.push(thread?.message_thread_id); return true;
		}
		override async downloadPhoto() { downloads++; return { data: "", mimeType: "image/jpeg" }; }
	}
	class Deck extends DeckClient {
		sessions: SessionSummary[] = ["a", "b", "foreign"].map((id) => ({ id, path: `/sessions/${id}`, cwd: "/project", title: id === "a" ? "Routing" : id === "b" ? "Release" : "Secret", createdAt: "1", updatedAt: "2", messageCount: 1 }));
		override async listSessions() { events.push("list"); return this.sessions; }
		override async createSession(opts: { cwd: string; resumeFromPath?: string }) {
			events.push("resume");
			const id = opts.resumeFromPath?.split("/").pop() ?? "new";
			return { sessionId: id, sessionFile: `/sessions/${id}`, cwd: opts.cwd };
		}
		override async promptSession() { events.push("prompt"); if (promptError) throw new Error("turn failed"); return "Finished"; }
		override async fileCards(cards: IntakeCard[]) {
			events.push("file");
			filedCards.push(...cards);
			return cards.map((card, index) => ({ ...card, displayId: index + 1 })) as Task[];
		}
	}
	const store = new TelegramBridgeStore(":memory:");
	const deck = new Deck(config.deckApiBase, config.deckWsUrl);
	const bridge = new TelegramBridge(policy, { telegram: new Transport("offline"), deck, store, identity: { id: 99, username: "deck_bot" } });
	return { events, replies, typingThreads, filedCards, deck, store, bridge, downloads: () => downloads, failPrompt: () => { promptError = true; }, send: (input: TelegramMessage) => bridge.dispatch({ update_id: input.message_id, message: input }) };
}

describe("attachment intake boundaries", () => {
	test("captioned unsupported media warns before a chat turn or task filing", async () => {
		const h = harness();
		try {
			for (const kind of ["document", "audio", "voice", "video", "video_note", "animation", "sticker"] as const) {
				h.events.length = 0; h.replies.length = 0;
				await h.send({ ...message, caption: "/chat summarize this", [kind]: { file_id: "not-downloaded" } });
				expect(h.replies[0]).toContain(`${kind} attachment not downloaded or processed`);
				expect(h.replies[0]).toContain("Only the caption text");
				expect(h.events.indexOf("reply")).toBeLessThan(h.events.indexOf("prompt"));
			}
			h.events.length = 0; h.replies.length = 0;
			await h.send({ ...message, caption: "/task 1. Research\n2. Write report", document: { file_id: "not-downloaded" } });
			expect(h.replies[0]).toContain("document attachment not downloaded");
			expect(h.replies.at(-1)).toContain("Filed 2 kanban cards");
			expect(h.events.indexOf("reply")).toBeLessThan(h.events.indexOf("file"));
			expect(h.downloads()).toBe(0);
		} finally { h.bridge.close(); }
	});
	test("a video captioned /help receives the attachment notice and still shows help", async () => {
		const h = harness();
		try {
			await h.send({ ...message, chat: { id: 7, type: "private" }, caption: "/help", video: { file_id: "not-downloaded" } });
			expect(h.replies[0]).toContain("video attachment not downloaded or processed");
			expect(h.replies[0]).toContain("Only the caption text");
			expect(h.replies[1]).toContain("/help or /commands");
			expect(h.events).toEqual(["reply", "reply"]);
			expect(h.downloads()).toBe(0);
		} finally { h.bridge.close(); }
	});
	test("unauthorized, ambient and ignored captions have no transport, session or card effects", async () => {
		const h = harness({ ...config, ignoredTopics: new Set(["-10:43"]) });
		try {
			for (const input of [
				{ ...message, from: { id: 8 }, caption: "/chat inspect" },
				{ ...message, caption: "ambient caption" },
				{ ...message, message_thread_id: 43, caption: "/chat inspect" },
				{ ...message, caption: "/chat@other_bot inspect" },
			]) await h.send({ ...input, document: { file_id: "not-downloaded" } });
			expect(h.events).toEqual([]);
			expect(h.store.list("-10:42")).toEqual([]);
			expect(h.downloads()).toBe(0);
			await h.send({ ...message, chat: { id: 7, type: "private" }, document: { file_id: "not-downloaded" } });
			expect(h.replies[0]).toContain("not downloaded or processed");
			expect(h.events).toEqual(["reply"]);
		} finally { h.bridge.close(); }
	});
});

describe("mention-gated task contents", () => {
	test("quoted usernames survive text and caption intake, including card ownership", async () => {
		const h = harness();
		try {
			const prose = "Investigate the literal '@deck_bot' without editing it";
			await h.send({ ...message, text: prose });
			await h.send({ ...message, message_id: 2, caption: "---\nread-only: true\nowner: '@deck_bot'\n---\nResearch the '@deck_bot' identifier", reply_to_message: { from: { id: 99 } } });
			expect(h.filedCards[0]).toEqual({ title: prose, body: prose });
			const body = h.filedCards[1]!.body!;
			const properties = parseProperties(body.slice(4, body.indexOf("\n---", 4)));
			expect(properties.owner).toBe("@deck_bot");
			expect(properties["read-only"]).toBe(true);
			expect(h.filedCards[1]!.title).toBe("Research the '@deck_bot' identifier");
			expect(body).toContain("Research the '@deck_bot' identifier");
		} finally { h.bridge.close(); }
	});
});

describe("retained conversation commands", () => {
	test("search numbers select the displayed lane result and title reads do not create sessions", async () => {
		const h = harness();
		try {
			await h.send({ ...message, text: "/title" });
			expect(h.replies.at(-1)).toContain("No bound session");
			expect(h.events).toEqual(["reply"]);
			for (const [id, lane] of [["a", "-10:42"], ["b", "-10:42"], ["foreign", "-10:43"]]) h.store.upsert({ chatId: lane!, sessionId: id!, sessionFile: `/sessions/${id}`, cwd: "/project", createdAt: "1", updatedAt: id === "a" ? "3" : "2" });
			await h.send({ ...message, text: "/sessions search releas" });
			expect(h.replies.at(-1)).toBe("1. Release · b · /project");
			await h.send({ ...message, text: "/resume 1" });
			expect(h.store.get("-10:42")?.sessionId).toBe("b");
			await h.send({ ...message, text: "/sessions routing" });
			expect(h.store.get("-10:42")?.sessionId).toBe("a");
			h.events.length = 0;
			await h.send({ ...message, text: "/title" });
			expect(h.replies.at(-1)).toBe("Current title: Routing");
			expect(h.events).not.toContain("resume");
			await h.send({ ...message, text: "/sessions search Secret" });
			expect(h.replies.at(-1)).toBe("No matching retained sessions in this conversation.");
			await h.send({ ...message, text: "/resume 1" });
			expect(h.store.get("-10:42")?.sessionId).toBe("a");
		} finally { h.bridge.close(); }
	});
	test("forum General typing keeps topic 1 even when message replies omit it", async () => {
		const h = harness();
		try {
			await h.send({ ...message, is_topic_message: undefined, message_thread_id: undefined, text: "/chat inspect" });
			expect(h.typingThreads).toEqual([1]);
			expect(h.store.get("-10:1")?.sessionId).toBe("new");
			h.failPrompt();
			await h.send({ ...message, text: "/chat fail" });
			expect(h.replies.at(-1)).toContain("Bridge error: Error: turn failed");
		} finally { h.bridge.close(); }
	});
});
