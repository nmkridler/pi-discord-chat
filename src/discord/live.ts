import { once } from "node:events";

import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";

import { chunkText, neutralizeMassPings } from "../chunking.js";
import { guessMimeType, readLocalAttachment } from "../log.js";
import type { InboundMessageInput, LiveConnection, LiveConnectionHandlers, ResolvedThread } from "../types.js";
import { storeDownloadedAttachment } from "./attachments.js";

async function withReadyClient(token: string): Promise<Client<true>> {
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		partials: [Partials.Channel],
	});
	const readyPromise = once(client, "ready");
	try {
		await client.login(token);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Used disallowed intents")) {
			throw new Error(
				'Discord rejected the configured gateway intents. Enable the "Message Content Intent" in the Discord Developer Portal under Bot settings, then reconnect.',
			);
		}
		throw error;
	}
	if (!client.isReady()) {
		await Promise.race([
			readyPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("Discord client failed to become ready")), 10000)),
		]);
	}
	if (!client.isReady()) throw new Error("Discord client failed to become ready");
	return client as Client<true>;
}

type DiscordThreadChannel = {
	sendTyping(): Promise<void>;
	messages: { fetch(idOrOptions?: unknown): Promise<Map<string, Message>> };
};

async function resolveThreadChannel(client: Client<true>, thread: ResolvedThread): Promise<DiscordThreadChannel> {
	const channel = await client.channels.fetch(thread.threadId);
	if (!channel?.isTextBased()) throw new Error(`Discord thread is not text-based: ${thread.threadId}`);
	return channel as unknown as DiscordThreadChannel;
}

async function messageToInput(thread: ResolvedThread, message: Message): Promise<InboundMessageInput | undefined> {
	if (message.channelId !== thread.threadId) return undefined;
	if (message.author.id === thread.account.botUserId) return undefined;
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	let index = 0;
	for (const attachment of message.attachments.values()) {
		const response = await fetch(attachment.url);
		if (!response.ok) continue;
		const data = new Uint8Array(await response.arrayBuffer());
		attachments.push(
			await storeDownloadedAttachment(
				thread,
				message.id,
				++index,
				attachment.name || `attachment-${index}`,
				data,
				attachment.contentType || undefined,
				attachment.url,
			),
		);
	}
	return {
		messageId: message.id,
		userId: message.author.id,
		userName: message.member?.displayName || message.author.username,
		roleIds: message.member?.roles.cache.map((role) => role.id),
		text: message.content || "",
		isBot: message.author.bot,
		attachments,
	};
}

async function postMessage(botToken: string, threadId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	const response = await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${botToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(payload),
		signal,
	});
	const data = (await response.json()) as { id?: string; message?: string };
	if (!response.ok || !data.id) throw new Error(data.message || "Discord send failed");
	return data.id;
}

async function sendThreadMessage(
	botToken: string,
	threadId: string,
	content: string,
	attachmentPaths: string[] = [],
	signal?: AbortSignal,
	replyToMessageId?: string,
): Promise<string> {
	const text = neutralizeMassPings(content);
	const chunks = chunkText(text);
	let firstMessageId: string | undefined;
	for (let i = 0; i < chunks.length; i++) {
		const payload: Record<string, unknown> = { content: chunks[i] };
		if (i === 0 && replyToMessageId) payload.message_reference = { message_id: replyToMessageId };
		if (i === chunks.length - 1 && attachmentPaths.length > 0) {
			const form = new FormData();
			form.set("payload_json", JSON.stringify(payload));
			for (const [index, path] of attachmentPaths.entries()) {
				const file = await readLocalAttachment(path);
				form.set(
					`files[${index}]`,
					new Blob([Buffer.from(file.data)], {
						type: file.mimeType || guessMimeType(path),
					}),
					file.name,
				);
			}
			const response = await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
				method: "POST",
				headers: { Authorization: `Bot ${botToken}` },
				body: form,
				signal,
			});
			const data = (await response.json()) as { id?: string; message?: string };
			if (!response.ok || !data.id) throw new Error(data.message || "Discord send failed");
			firstMessageId ??= data.id;
		} else {
			const id = await postMessage(botToken, threadId, payload, signal);
			firstMessageId ??= id;
		}
	}
	return firstMessageId || "";
}

async function catchUp(client: Client<true>, thread: ResolvedThread, handlers: LiveConnectionHandlers, afterId?: string): Promise<void> {
	const channel = await resolveThreadChannel(client, thread);
	const allMessages: Message[] = [];
	let cursor = afterId;
	while (true) {
		const batch = await channel.messages.fetch(cursor ? { after: cursor, limit: 100 } : { limit: 25 });
		if (batch.size === 0) break;
		const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
		allMessages.push(...sorted);
		cursor = sorted[sorted.length - 1].id;
		if (batch.size < 100) break;
	}
	for (const message of allMessages) {
		const input = await messageToInput(thread, message);
		if (!input) continue;
		await handlers.onMessage(input, { cursor: input.messageId });
	}
}

export async function connectWorkerLive(
	thread: ResolvedThread,
	handlers: LiveConnectionHandlers,
	lastCursor?: string,
): Promise<LiveConnection> {
	const botToken = thread.account.botToken;
	const client = await withReadyClient(botToken);
	await catchUp(client, thread, handlers, lastCursor);
	await handlers.onCaughtUp();

	let statusMessageId: string | undefined;
	let statusChain: Promise<void> = Promise.resolve();
	const queueStatusOp = (op: () => Promise<void>): Promise<void> => {
		statusChain = statusChain.then(op).catch(() => undefined);
		return statusChain;
	};

	const onMessageCreate = async (message: Message) => {
		try {
			const input = await messageToInput(thread, message);
			if (!input) return;
			await handlers.onMessage(input, { cursor: input.messageId });
		} catch (error) {
			await handlers.onError(error instanceof Error ? error : new Error(String(error)));
		}
	};
	client.on(Events.MessageCreate, onMessageCreate);

	let disconnectFired = false;
	const fireDisconnect = () => {
		if (disconnectFired) return;
		disconnectFired = true;
		void handlers.onDisconnect?.();
	};
	client.on(Events.Error, (error) => void handlers.onError(error instanceof Error ? error : new Error(String(error))));
	client.on(Events.Invalidated, () => fireDisconnect());
	client.on("disconnect", () => fireDisconnect());
	(client.ws as unknown as { on(event: "close", listener: () => void): void }).on("close", () => {
		setTimeout(() => {
			if (!client.isReady()) fireDisconnect();
		}, 30000);
	});

	return {
		thread,
		disconnect: async () => {
			client.off(Events.MessageCreate, onMessageCreate);
			client.destroy();
		},
		sendImmediate: async (text, replyToMessageId) => sendThreadMessage(botToken, thread.threadId, text, [], undefined, replyToMessageId),
		send: async (text, attachmentPaths = [], signal, replyToMessageId) =>
			sendThreadMessage(botToken, thread.threadId, text, attachmentPaths, signal, replyToMessageId),
		startTyping: async () => {
			const channel = await resolveThreadChannel(client, thread);
			await channel.sendTyping();
		},
		stopTyping: async () => {},
		setToolStatus: async (line) => {
			await queueStatusOp(async () => {
				if (!statusMessageId) {
					statusMessageId = await postMessage(botToken, thread.threadId, {
						content: line,
					});
					return;
				}
				const response = await fetch(`https://discord.com/api/v10/channels/${thread.threadId}/messages/${statusMessageId}`, {
					method: "PATCH",
					headers: {
						Authorization: `Bot ${botToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ content: line }),
				});
				if (!response.ok) statusMessageId = undefined;
			});
		},
		clearToolStatus: async () => {
			await queueStatusOp(async () => {
				if (!statusMessageId) return;
				const id = statusMessageId;
				statusMessageId = undefined;
				await fetch(`https://discord.com/api/v10/channels/${thread.threadId}/messages/${id}`, {
					method: "DELETE",
					headers: { Authorization: `Bot ${botToken}` },
				});
			});
		},
	};
}
