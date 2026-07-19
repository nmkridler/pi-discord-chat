import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ChatConfig, DiscordAccountConfig, ResolvedThread } from "./types.js";

export const CHAT_HOME = join(homedir(), ".pi", "discord-chat");
export const CHAT_CONFIG_PATH = join(CHAT_HOME, "config.json");

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export async function ensureChatHome(): Promise<void> {
	await mkdir(CHAT_HOME, { recursive: true });
}

function validateAccount(accountId: string, account: unknown): DiscordAccountConfig {
	const value = (account ?? {}) as Partial<DiscordAccountConfig>;
	const missing = (["botToken", "botUserId", "parentChannelId"] as const).filter(
		(field) => typeof value[field] !== "string" || !value[field]?.trim(),
	);
	if (missing.length > 0) {
		throw new Error(
			`${CHAT_CONFIG_PATH}: account "${accountId}" is missing required field(s): ${missing.join(", ")}. See the pi-discord-chat README for the config file format.`,
		);
	}
	return value as DiscordAccountConfig;
}

export async function loadChatConfig(): Promise<ChatConfig> {
	await ensureChatHome();
	let content: string;
	try {
		content = await readFile(CHAT_CONFIG_PATH, "utf8");
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : undefined;
		if (code === "ENOENT") return { accounts: {} };
		throw error;
	}
	let parsed: { accounts?: Record<string, unknown> };
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${CHAT_CONFIG_PATH}: invalid JSON (${message}).`);
	}
	const accounts: Record<string, DiscordAccountConfig> = {};
	for (const [accountId, account] of Object.entries(parsed.accounts ?? {})) {
		accounts[accountId] = validateAccount(accountId, account);
	}
	return { accounts };
}

function accountDir(accountId: string): string {
	return join(CHAT_HOME, "accounts", sanitize(accountId));
}

function threadDir(accountId: string, threadId: string): string {
	return join(accountDir(accountId), "threads", sanitize(threadId));
}

export function resolveThread(config: ChatConfig, accountId: string, threadId: string, threadName?: string): ResolvedThread | undefined {
	const account = config.accounts[accountId];
	if (!account) return undefined;
	const dir = threadDir(accountId, threadId);
	const workspaceDir = join(dir, "workspace");
	return {
		accountId,
		account,
		threadId,
		threadName: threadName ?? threadId,
		conversationId: `${accountId}/${threadId}`,
		access: account.access ?? {},
		threadDir: dir,
		workspaceDir,
		filesDir: join(workspaceDir, "attachments"),
		logPath: join(dir, "log.jsonl"),
		lockPath: join(dir, ".lock"),
	};
}
