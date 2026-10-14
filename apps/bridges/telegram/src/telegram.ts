export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramMessage {
	message_id: number;
	chat: { id: number; type: string; is_forum?: boolean };
	message_thread_id?: number;
	is_topic_message?: boolean;
	direct_messages_topic?: { topic_id: number };
	reply_to_message?: { from?: { id: number; is_bot?: boolean } };
	location?: { latitude: number; longitude: number };
	venue?: { title: string; address: string; location: { latitude: number; longitude: number } };
	from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
	document?: { file_id: string };
	audio?: { file_id: string };
	voice?: { file_id: string };
	video?: { file_id: string };
	video_note?: { file_id: string };
	animation?: { file_id: string };
	sticker?: { file_id: string };
	contact?: object;
	poll?: object;
	dice?: object;
	paid_media?: object;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

interface TelegramResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramSentMessage {
	message_id: number;
	chat: { id: number };
	text?: string;
}

interface TelegramFile {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

export class TelegramApi {
	private readonly apiBase: string;
	private readonly fileBase: string;

	constructor(private readonly botToken: string) {
		this.apiBase = `https://api.telegram.org/bot${botToken}`;
		this.fileBase = `https://api.telegram.org/file/bot${botToken}`;
	}

	getMe(): Promise<{ id: number; username: string }> {
		return this.call("getMe", {});
	}

	setCommands(commands: { command: string; description: string }[]): Promise<boolean> {
		return this.call("setMyCommands", { commands });
	}

	getUpdates(offset: number | undefined, timeout: number): Promise<TelegramUpdate[]> {
		return this.call<TelegramUpdate[]>("getUpdates", {
			...(offset !== undefined ? { offset } : {}),
			timeout,
			allowed_updates: ["message"],
		});
	}

	sendMessage(chatId: number | string, text: string, replyToMessageId?: number, thread?: { message_thread_id?: number; direct_messages_topic_id?: number }): Promise<TelegramSentMessage> {
		return this.call<TelegramSentMessage>("sendMessage", {
			chat_id: chatId,
			text,
			disable_web_page_preview: true,
			...(replyToMessageId !== undefined ? { reply_to_message_id: replyToMessageId } : {}),
			...thread,
		});
	}

	sendTyping(chatId: number | string, thread?: { message_thread_id?: number; direct_messages_topic_id?: number }): Promise<boolean> {
		return this.call("sendChatAction", { chat_id: chatId, action: "typing", ...thread });
	}

	editMessageText(chatId: number | string, messageId: number, text: string): Promise<TelegramSentMessage> {
		return this.call<TelegramSentMessage>("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			text,
			disable_web_page_preview: true,
		});
	}

	async downloadPhoto(photo: TelegramPhotoSize): Promise<{ data: string; mimeType: string }> {
		const file = await this.call<TelegramFile>("getFile", { file_id: photo.file_id });
		if (!file.file_path) throw new Error("Telegram getFile returned no file_path");
		let res: Response;
		try {
			res = await fetch(`${this.fileBase}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
		} catch {
			throw new Error("Telegram file download failed (network or timeout).");
		}
		if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		return { data: bytes.toString("base64"), mimeType: mimeTypeForTelegramPath(file.file_path) };
	}

	private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.apiBase}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(method === "getUpdates" ? (Number(body.timeout) + 10) * 1000 : 30_000),
			});
		} catch {
			// Native fetch errors can contain the credential-bearing URL.
			throw new Error(`Telegram ${method} failed (network or timeout).`);
		}
		let payload: TelegramResponse<T>;
		try {
			payload = (await res.json()) as TelegramResponse<T>;
		} catch {
			throw new Error(`Telegram ${method} failed: HTTP ${res.status}`);
		}
		if (!res.ok || !payload.ok || payload.result === undefined) {
			const description = payload.description?.replaceAll(this.botToken, "[redacted]");
			throw new Error(`Telegram ${method} failed: ${description ?? `HTTP ${res.status}`}`);
		}
		return payload.result;
	}
}

function mimeTypeForTelegramPath(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/jpeg";
}
