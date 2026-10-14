import type { ImageAttachment } from "@npi-deck/protocol";

import { loadTelegramBridgeConfig, type TelegramBridgeConfig } from "./config.ts";
import { DeckClient, SessionNotActiveError } from "./deck.ts";
import { nowIso, TelegramBridgeStore, type ChatSessionMapping } from "./store.ts";
import { TelegramApi, type TelegramMessage, type TelegramUpdate } from "./telegram.ts";
import { conversationKey, decomposeTask, effectiveThreadId, HELP, invokedText, parseCommand, parseProperties, retainedSessions, selectRetainedSession, unsupportedAttachments, type BotIdentity, type RetainedSession } from "./commands.ts";
import { stringify } from "yaml";

const TELEGRAM_TEXT_LIMIT = 3900;

export class TelegramBridge {
	private readonly telegram: TelegramApi;
	private readonly deck: DeckClient;
	private readonly store: TelegramBridgeStore;
	private readonly queues = new Map<string, Promise<void>>();
	private readonly sessionChoices = new Map<string, RetainedSession[]>();
	private offset: number | undefined;
	private stopping = false;
	private bot: BotIdentity | undefined;

	constructor(private readonly config: TelegramBridgeConfig, services?: { telegram?: TelegramApi; deck?: DeckClient; store?: TelegramBridgeStore; identity?: BotIdentity }) {
		this.telegram = services?.telegram ?? new TelegramApi(config.botToken);
		this.deck = services?.deck ?? new DeckClient(config.deckApiBase, config.deckWsUrl);
		this.store = services?.store ?? new TelegramBridgeStore(config.dbPath);
		this.bot = services?.identity;
	}

	async run(): Promise<void> {
		this.bot = await this.telegram.getMe();
		await this.telegram.setCommands(["help", "task", "capture", "inbox", "chat", "session", "sessions", "bind", "resume", "new", "stop", "properties", "model", "title", "compact"]
			.map((command) => ({ command, description: HELP.split("\n").find((line) => line.startsWith(`/${command}`))?.split(" — ")[1]?.slice(0, 100) ?? command })));
		console.info("telegram bridge started", { deckApiBase: this.config.deckApiBase, allowedUsers: this.config.allowedUserIds.size, allowedGroups: this.config.allowedChatIds.size });
		while (!this.stopping) {
			try {
				for (const update of await this.telegram.getUpdates(this.offset, this.config.pollTimeoutSeconds)) {
					void this.dispatch(update);
				}
			} catch (err) {
				if (!this.stopping) { console.error("telegram poll failed", this.safeError(err)); await sleep(3000); }
			}
		}
		await Promise.allSettled(this.queues.values());
		this.close();
	}

	stop(): void { this.stopping = true; }
	close(): void { this.store.close(); }

	/** Public ingress seam for offline transport simulation; no polling or external sends required. */
	dispatch(update: TelegramUpdate): Promise<void> {
		this.offset = Math.max(this.offset ?? 0, update.update_id + 1);
		const message = update.message;
		if (!message) return Promise.resolve();
		if (!this.bot) throw new Error("Bot identity is required before dispatch.");
		const text = invokedText(message, this.config, this.bot);
		if (text === undefined) return Promise.resolve();
		const key = conversationKey(message);
		// Abort must not wait behind the prompt it is cancelling.
		if (parseCommand(text, this.bot.username)?.name === "stop") return this.handleMessage(message, text).catch((err) => this.reportError(message, err));
		const next = (this.queues.get(key) ?? Promise.resolve())
			.catch(() => undefined).then(() => this.handleMessage(message, text))
			.catch((err) => this.reportError(message, err))
			.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
		this.queues.set(key, next);
		return next;
	}

	private safeError(err: unknown): string {
		return String(err).replaceAll(this.config.botToken, "[redacted]");
	}

	private async reportError(message: TelegramMessage, err: unknown): Promise<void> {
		console.error("telegram message handling failed", { key: conversationKey(message), error: this.safeError(err) });
		try { await this.say(message, `Bridge error: ${this.safeError(err)}. Check the inbox before resending a task; completed cards are retained.`); }
		catch { console.error("telegram error reply failed"); }
	}

	private async say(message: TelegramMessage, text: string): Promise<void> {
		for (const chunk of splitTelegramText(text)) await this.telegram.sendMessage(message.chat.id, chunk, message.message_id, threadRouting(message));
	}

	private async handleMessage(message: TelegramMessage, text: string): Promise<void> {
		const key = conversationKey(message);
		const command = parseCommand(text, this.bot!.username);
		const args = command?.args ?? text;
		const unsupported = unsupportedAttachments(message);
		if (unsupported.length) {
			await this.say(message, `${unsupported.join(", ")} attachment not downloaded or processed.${text ? " Only the caption text will be used." : " Send task text, or /chat with a photo for image analysis."}`);
			if (!text && !message.photo?.length) return;
		}
		switch (command?.name) {
			case "start": case "help": case "commands": return this.say(message, HELP);
			case "new": case "reset":
				this.store.delete(key); // Detach only: stable NeoPi and old transcripts remain intact.
				return this.say(message, "Binding cleared. /chat starts fresh; /resume can restore a retained session.");
			case "session": case "status": {
				const mapping = this.store.get(key);
				const title = mapping ? (await this.deck.listSessions()).find((session) => session.id === mapping.sessionId)?.title : undefined;
				return this.say(message, mapping ? `Conversation ${key}\nSession ${mapping.sessionId}\nTitle ${title ?? "Untitled"}\nWorkspace ${mapping.cwd}` : `Conversation ${key} has no binding. Use /bind or /chat.`);
			}
			case "sessions": {
				if (args && !/^search(?:\s|$)/i.test(args)) return this.resumeSelected(message, key, args);
				const query = args ? args.replace(/^search/i, "").trim().toLowerCase() : undefined;
				if (query === "") throw new Error("Usage: /sessions search <query>");
				let sessions = await this.retained(key);
				if (query) sessions = sessions.filter((session) => [session.title, session.mapping.sessionId].some((value) => value?.toLowerCase().includes(query)));
				this.sessionChoices.set(key, sessions);
				return this.say(message, sessions.map((entry, i) => `${i + 1}. ${entry.title ?? "Untitled"} · ${entry.mapping.sessionId} · ${entry.mapping.cwd}`).join("\n") || (query ? "No matching retained sessions in this conversation." : "No retained sessions in this conversation."));
			}
			case "bind": {
				if (!args) throw new Error("Usage: /bind <existing deck session ID>");
				const session = (await this.deck.listSessions()).find((entry) => entry.id === args);
				if (!session) throw new Error("Unknown deck session ID.");
				// Deck resume is idempotent: its active session is reused, never restarted.
				this.saveMapping(key, await this.deck.createSession({ cwd: session.cwd, resumeFromPath: session.path }));
				return this.say(message, `Bound ${args} to conversation ${key}.`);
			}
			case "resume": return this.resumeSelected(message, key, args);
			case "properties":
				if (args) {
					const properties = args === "clear" ? {} : parseProperties(args);
					// Validate known execution properties before persisting defaults.
					decomposeTask("validation", properties);
					this.store.setProperties(key, properties);
				}
				return this.say(message, `Default card properties for ${key}:\n${stringify(this.store.getProperties(key))}`);
			case "capture":
				if (!args) throw new Error("Usage: /capture <text>");
				const item = await this.deck.capture(args.split("\n")[0]!.slice(0, 200), args, `telegram:${key}:${message.message_id}`);
				return this.say(message, `Saved inbox capture ${item.id}; not promoted to a card.`);
			case "inbox":
				return this.say(message, (await this.deck.listInbox()).map((item) => `${item.id} · ${item.kind} · ${item.title}`).join("\n") || "Inbox is clear.");
			case "stop": {
				const mapping = this.store.get(key);
				if (mapping) await this.deck.sessionAction(mapping.sessionId, "abort");
				return this.say(message, mapping ? "Abort requested for the bound session." : "No bound session to stop.");
			}
			case "title": case "model": case "compact": {
				if (command.name === "title" && !args) {
					const current = this.store.get(key);
					if (!current) return this.say(message, "No bound session. Use /bind or /chat.");
					const title = (await this.deck.listSessions()).find((session) => session.id === current.sessionId)?.title;
					return this.say(message, `Current title: ${title ?? "Untitled"}`);
				}
				const mapping = await this.ensureActiveMapping(key);
				if (command.name === "title") {
					// The no-argument form above only reads; renaming may resume the binding.
					await this.deck.updateSession(mapping.sessionId, { name: args });
				} else if (command.name === "compact") await this.deck.sessionAction(mapping.sessionId, "compact", args ? { focus: args } : {});
				else {
					if (!args) return this.say(message, (await this.deck.models(mapping.sessionId)).models.map((model) => `${model.provider}/${model.id}`).join("\n"));
					const slash = args.indexOf("/");
					if (slash <= 0 || slash === args.length - 1) throw new Error("Usage: /model <provider/model>");
					await this.deck.updateSession(mapping.sessionId, { model: { provider: args.slice(0, slash), id: args.slice(slash + 1) } });
				}
				return this.say(message, `Session ${command.name} updated.`);
			}
			case "chat": return this.chat(message, args);
			case "task": break;
			case undefined: break;
			default: return this.say(message, "Unknown bridge command. Use /help, or /chat /<native-command> for a NeoPi command.");
		}
		const location = message.venue?.location ?? message.location;
		const task = args || (location ? `${message.venue?.title ?? "Location"}${message.venue ? ` · ${message.venue.address}` : ""}\nLatitude: ${location.latitude}, longitude: ${location.longitude}` : "");
		if (!task) return this.say(message, "Send task text or a caption. Use /chat with a photo for image analysis. Audio, video and document extraction are not supported by the deck image protocol.");
		const cards = decomposeTask(task, this.store.getProperties(key));
		const filed = await this.deck.fileCards(cards, `telegram:${key}:${message.message_id}`);
		return this.say(message, `Filed ${filed.length} kanban card${filed.length === 1 ? "" : "s"} through the inbox:\n${filed.map((card) => `T-${card.displayId} · ${card.title}`).join("\n")}${message.photo?.length ? "\nPhoto not attached to cards; use /chat with a photo for image analysis." : ""}`);
	}

	private async chat(message: TelegramMessage, text: string): Promise<void> {
		const photos = message.photo ?? [];
		if (!text && !photos.length) throw new Error("Usage: /chat <text>, or a photo captioned /chat");
		let typingPending: Promise<void> | undefined;
		const typing = () => {
			typingPending ??= this.telegram.sendTyping(message.chat.id, threadRouting(message, true))
				.then(() => undefined, () => { console.warn("telegram typing indicator failed"); })
				.finally(() => { typingPending = undefined; });
			return typingPending;
		};
		await typing();
		const typingTimer = setInterval(() => { void typing(); }, 4000);
		try {
			const images: ImageAttachment[] = [];
			const largest = photos[photos.length - 1];
			if (largest) images.push({ type: "image", ...await this.telegram.downloadPhoto(largest) });
			const key = conversationKey(message);
			let mapping = await this.ensureMapping(key);
			const reply = new TelegramReply(this.telegram, message.chat.id, message.message_id, this.config.editIntervalMs, threadRouting(message));
			const prompt = () => this.deck.promptSession({ sessionId: mapping.sessionId, text: text || "Please analyze this image.", ...(images.length ? { images } : {}), onText: (next) => reply.update(next) });
			try {
				await reply.finish(await prompt());
			} catch (err) {
				if (!(err instanceof SessionNotActiveError)) { await reply.finish(`Bridge error: ${this.safeError(err)}`); return; }
				mapping = await this.resumeMapping(mapping);
				await reply.finish(await prompt());
			}
		} finally {
			clearInterval(typingTimer);
			await typingPending;
		}
	}

	private async retained(key: string): Promise<RetainedSession[]> {
		const mappings = this.store.list(key);
		return mappings.length ? retainedSessions(mappings, await this.deck.listSessions()) : [];
	}

	private async resumeSelected(message: TelegramMessage, key: string, selector: string): Promise<void> {
		const sessions = await this.retained(key);
		// Numbers refer to exactly the latest displayed list, including search results.
		const choices = /^[1-9]\d*$/.test(selector) ? this.sessionChoices.get(key) ?? sessions : sessions;
		const selected = selectRetainedSession(choices, selector);
		if (!sessions.some((session) => session.mapping.sessionId === selected.sessionId)) throw new Error("That session is no longer retained. Refresh /sessions.");
		const resumed = await this.resumeMapping(selected);
		return this.say(message, `Resumed session ${resumed.sessionId} in conversation ${key}.`);
	}

	private saveMapping(key: string, created: { sessionId: string; sessionFile?: string; cwd: string }): ChatSessionMapping {
		const now = nowIso();
		const mapping = { chatId: key, ...created, createdAt: now, updatedAt: now };
		this.store.upsert(mapping);
		return mapping;
	}

	private async ensureMapping(key: string): Promise<ChatSessionMapping> {
		return this.store.get(key) ?? this.saveMapping(key, await this.deck.createSession({ cwd: this.config.defaultCwd }));
	}

	private async ensureActiveMapping(key: string): Promise<ChatSessionMapping> {
		const existing = this.store.get(key);
		return existing ? this.resumeMapping(existing) : this.ensureMapping(key);
	}

	private async resumeMapping(mapping: ChatSessionMapping): Promise<ChatSessionMapping> {
		if (!mapping.sessionFile) throw new Error("Bound session has no retained transcript. Use /bind or /new; no fresh session was substituted.");
		return this.saveMapping(mapping.chatId, await this.deck.createSession({ cwd: mapping.cwd, resumeFromPath: mapping.sessionFile }));
	}
}

function threadRouting(message: TelegramMessage, typing = false): { message_thread_id?: number; direct_messages_topic_id?: number } {
	if (message.direct_messages_topic) return { direct_messages_topic_id: message.direct_messages_topic.topic_id };
	const thread = effectiveThreadId(message);
	return thread !== undefined && (typing || thread !== 1) ? { message_thread_id: thread } : {};
}

class TelegramReply {
	private sent: Promise<{ message_id: number }> | undefined;
	private latest = "";
	private rendered = "";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly telegram: TelegramApi,
		private readonly chatId: number,
		private readonly replyToMessageId: number,
		private readonly editIntervalMs: number,
		private readonly thread: { message_thread_id?: number; direct_messages_topic_id?: number },
	) {}

	update(text: string): void {
		this.latest = text;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.enqueueFlush();
		}, this.editIntervalMs);
	}

	async finish(text: string): Promise<void> {
		this.latest = text || this.latest || "Turn complete.";
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.chain;
		const chunks = splitTelegramText(this.latest);
		await this.editRendered(chunks[0]!);
		for (const chunk of chunks.slice(1)) await this.telegram.sendMessage(this.chatId, chunk, this.replyToMessageId, this.thread);
	}

	private enqueueFlush(): Promise<void> {
		this.chain = this.chain.then(() => this.flush()).catch((err) => console.warn("telegram reply edit failed", err));
		return this.chain;
	}

	private async flush(): Promise<void> {
		const next = truncateTelegramText(this.latest || "Working...");
		if (next === this.rendered) return;
		await this.editRendered(next);
	}

	private async editRendered(text: string): Promise<void> {
		if (text === this.rendered) return;
		const sent = await this.ensureSent();
		try {
			await this.telegram.editMessageText(this.chatId, sent.message_id, text);
			this.rendered = text;
		} catch (err) {
			if (!String(err).includes("message is not modified")) throw err;
		}
	}

	private ensureSent(): Promise<{ message_id: number }> {
		this.sent ??= this.telegram.sendMessage(this.chatId, "Working...", this.replyToMessageId, this.thread);
		return this.sent;
	}
}

function splitTelegramText(text: string): string[] {
	const trimmed = text.trim() || "Turn complete.";
	const chunks: string[] = [];
	let rest = trimmed;
	while (rest.length > TELEGRAM_TEXT_LIMIT) {
		let cut = rest.lastIndexOf("\n", TELEGRAM_TEXT_LIMIT);
		if (cut < TELEGRAM_TEXT_LIMIT * 0.6) cut = TELEGRAM_TEXT_LIMIT;
		if (/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? "")) cut--;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	chunks.push(rest);
	return chunks;
}

function truncateTelegramText(text: string): string {
	const chunks = splitTelegramText(text);
	return chunks.length === 1 ? chunks[0]! : `${chunks[0]!}\n\n...`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const bridge = new TelegramBridge(loadTelegramBridgeConfig());
	process.once("SIGINT", () => bridge.stop());
	process.once("SIGTERM", () => bridge.stop());
	await bridge.run();
}

if (import.meta.main) main().catch(() => {
	console.error("telegram bridge fatal (check configuration and transport availability)");
	process.exit(1);
});
