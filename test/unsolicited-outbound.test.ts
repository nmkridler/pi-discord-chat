import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationRuntime } from "../src/runtime.js";
import type { ResolvedThread } from "../src/types.js";

test("records an unsolicited assistant reply without resolving an inbound job", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-chat-unsolicited-outbound-"));
	const threadDir = join(dir, "thread");
	const thread: ResolvedThread = {
		accountId: "test-account",
		account: { botToken: "test-token", botUserId: "bot-123", parentChannelId: "channel-123" },
		threadId: "thread-123",
		threadName: "test-thread",
		conversationId: "conv-123",
		access: { ignoreBots: true },
		threadDir,
		workspaceDir: join(dir, "workspace"),
		filesDir: join(dir, "files"),
		logPath: join(threadDir, "chat.jsonl"),
		lockPath: join(threadDir, "lock"),
	};

	try {
		const runtime = await ConversationRuntime.connect(thread, "test-owner");
		await runtime.recordUnsolicitedOutbound("Async worker finished", "discord-outbound-1");

		const records = (await readFile(thread.logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; messageId?: string; text?: string; jobId?: string });
		assert.equal(records.length, 1);
		assert.equal(records[0].type, "outbound");
		assert.equal(records[0].messageId, "discord-outbound-1");
		assert.equal(records[0].text, "Async worker finished");
		assert.equal(records[0].jobId, undefined);
		assert.equal(runtime.getStatus().queueLength, 0);
		assert.equal(runtime.getStatus().hasActiveJob, false);

		await runtime.disconnect();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
