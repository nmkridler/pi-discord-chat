import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationRuntime } from "../src/runtime.js";
import type { ResolvedThread } from "../src/types.js";

async function createTestThread(prefix = "pi-chat-lifecycle-"): Promise<{ thread: ResolvedThread; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const threadDir = join(dir, "thread");
	const workspaceDir = join(dir, "workspace");
	const filesDir = join(dir, "files");
	const logPath = join(threadDir, "chat.jsonl");
	const lockPath = join(threadDir, "lock");

	const thread: ResolvedThread = {
		accountId: "test-account",
		account: {
			botToken: "test-token",
			botUserId: "bot-123",
			parentChannelId: "channel-123",
		},
		threadId: "thread-123",
		threadName: "test-thread",
		conversationId: "conv-123",
		access: {
			allowedUserIds: ["allowed-user-1"],
			ignoreBots: true,
		},
		threadDir,
		workspaceDir,
		filesDir,
		logPath,
		lockPath,
	};

	return {
		thread,
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

test("access control policy respects allowedUserIds and ignoreBots", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const runtime = await ConversationRuntime.connect(thread, "test-owner");

		// Bot message should be ignored
		const resBot = await runtime.ingestInbound({
			messageId: "bot-msg",
			userId: "bot-user",
			text: "Hello from a bot",
			isBot: true,
		});
		assert.equal(resBot.jobQueued, false);

		// Disallowed user message should be ignored
		const resDisallowed = await runtime.ingestInbound({
			messageId: "unauthorized-msg",
			userId: "disallowed-user",
			text: "Hello from unauthorized user",
			isBot: false,
		});
		assert.equal(resDisallowed.jobQueued, false);

		// Allowed user message should be queued
		const resAllowed = await runtime.ingestInbound({
			messageId: "allowed-msg",
			userId: "allowed-user-1",
			userName: "Alice",
			text: "Hello from Alice",
			isBot: false,
		});
		assert.equal(resAllowed.jobQueued, true);

		const job = runtime.beginNextJob();
		assert.ok(job);
		assert.equal(job.triggerMessageId, "allowed-msg");

		await runtime.disconnect();
	} finally {
		await cleanup();
	}
});

test("transcript and prompt bundling accumulates messages across turns correctly", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const runtime = await ConversationRuntime.connect(thread, "test-owner");

		// Turn 1: user sends message 1
		await runtime.ingestInbound({
			messageId: "turn-1-msg",
			userId: "allowed-user-1",
			userName: "Alice",
			text: "Question 1",
		});

		const job1 = runtime.beginNextJob();
		assert.ok(job1);
		assert.match(job1.prompt, /Question 1/);

		await runtime.completeActiveJob("Answer 1", "turn-1-out");

		// Turn 2: user sends message 2
		await runtime.ingestInbound({
			messageId: "turn-2-msg",
			userId: "allowed-user-1",
			userName: "Alice",
			text: "Question 2",
		});

		const job2 = runtime.beginNextJob();
		assert.ok(job2);
		// Prompt for turn 2 should contain Question 2, not re-include Question 1
		assert.match(job2.prompt, /Question 2/);
		assert.doesNotMatch(job2.prompt, /Question 1/);

		await runtime.completeActiveJob("Answer 2", "turn-2-out");

		await runtime.disconnect();
	} finally {
		await cleanup();
	}
});

test("control command parsing handles stop, clear, compact, model, status", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const runtime = await ConversationRuntime.connect(thread, "test-owner");

		assert.equal(runtime.parseControlCommand({ userId: "allowed-user-1", text: "/stop" }), "stop");
		assert.equal(runtime.parseControlCommand({ userId: "allowed-user-1", text: "stop" }), "stop");
		assert.equal(runtime.parseControlCommand({ userId: "allowed-user-1", text: "/clear" }), "clear");
		assert.equal(runtime.parseControlCommand({ userId: "allowed-user-1", text: "new" }), "clear");
		assert.equal(runtime.parseControlCommand({ userId: "allowed-user-1", text: "/status" }), "status");
		assert.deepEqual(runtime.parseControlCommand({ userId: "allowed-user-1", text: "/model claude-3-5-sonnet" }), {
			type: "model",
			name: "claude-3-5-sonnet",
		});
		assert.deepEqual(runtime.parseControlCommand({ userId: "allowed-user-1", text: "/compact summarize briefly" }), {
			type: "compact",
			instructions: "summarize briefly",
		});
		assert.deepEqual(runtime.parseControlCommand({ userId: "allowed-user-1", text: "/compact" }), {
			type: "compact",
		});

		// Disallowed user control commands are ignored
		assert.equal(runtime.parseControlCommand({ userId: "random-user", text: "/stop" }), undefined);

		await runtime.disconnect();
	} finally {
		await cleanup();
	}
});
