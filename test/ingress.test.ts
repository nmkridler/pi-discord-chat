import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationRuntime, isCursorNewer } from "../src/runtime.js";
import type { ResolvedThread } from "../src/types.js";

async function createTestThread(prefix = "pi-chat-ingress-"): Promise<{ thread: ResolvedThread; cleanup: () => Promise<void> }> {
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

test("isCursorNewer correctly compares snowflake IDs and numeric cursors monotonically", () => {
	assert.equal(isCursorNewer("100000000000000002", "100000000000000001"), true);
	assert.equal(isCursorNewer("100000000000000001", "100000000000000002"), false);
	assert.equal(isCursorNewer("100000000000000001", "100000000000000001"), false);
	assert.equal(isCursorNewer("100000000000000001", undefined), true);
	assert.equal(isCursorNewer(undefined, "100000000000000001"), false);
});

test("checkpoint cursor never moves backward when deliveries complete out of order", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const runtime = await ConversationRuntime.connect(thread, "test-owner");

		await runtime.noteCheckpoint({ cursor: "100000000000000050" });
		assert.equal(runtime.getLastCheckpoint().cursor, "100000000000000050");

		// Slower earlier delivery attempts to write an older cursor
		await runtime.noteCheckpoint({ cursor: "100000000000000020" });
		assert.equal(runtime.getLastCheckpoint().cursor, "100000000000000050");

		// Equal cursor does not write
		await runtime.noteCheckpoint({ cursor: "100000000000000050" });
		assert.equal(runtime.getLastCheckpoint().cursor, "100000000000000050");

		// Newer cursor advances checkpoint
		await runtime.noteCheckpoint({ cursor: "100000000000000099" });
		assert.equal(runtime.getLastCheckpoint().cursor, "100000000000000099");

		await runtime.disconnect();
	} finally {
		await cleanup();
	}
});

test("serializes ingress so message with attachment handling arrives before subsequent plain text message", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const runtime = await ConversationRuntime.connect(thread, "test-owner");

		// Create a temporary file to use as attachment
		const sampleFilePath = join(thread.workspaceDir, "sample.txt");
		await writeFile(sampleFilePath, "attachment file content", "utf8");

		// Concurrently invoke ingestInbound for msg1 (with attachment) and msg2 (plain text)
		const p1 = runtime.ingestInbound(
			{
				messageId: "msg-100",
				userId: "user-1",
				userName: "Alice",
				text: "First message with attachment",
				attachments: [
					{
						path: sampleFilePath,
						name: "sample.txt",
					},
				],
			},
			{ cursor: "100" },
		);

		const p2 = runtime.ingestInbound(
			{
				messageId: "msg-101",
				userId: "user-1",
				userName: "Alice",
				text: "Second message plain text",
			},
			{ cursor: "101" },
		);

		const [res1, res2] = await Promise.all([p1, p2]);
		assert.equal(res1.jobQueued, true);
		assert.equal(res2.jobQueued, true);

		// Verify job execution order
		const job1 = runtime.beginNextJob();
		assert.ok(job1);
		assert.match(job1.prompt, /First message with attachment/);
		assert.match(job1.prompt, /sample\.txt/);
		assert.equal(job1.triggerMessageId, "msg-100");

		await runtime.completeActiveJob("reply 1", "out-1");

		const job2 = runtime.beginNextJob();
		assert.ok(job2);
		assert.match(job2.prompt, /Second message plain text/);
		assert.equal(job2.triggerMessageId, "msg-101");

		await runtime.completeActiveJob("reply 2", "out-2");

		await runtime.disconnect();
	} finally {
		await cleanup();
	}
});

test("message delivered by both catch-up and MessageCreate produces one inbound record and one turn", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const runtime = await ConversationRuntime.connect(thread, "test-owner");

		const input = {
			messageId: "msg-duplicate-1",
			userId: "user-1",
			userName: "Bob",
			text: "Duplicate message",
		};

		// First delivery (e.g. MessageCreate)
		const res1 = await runtime.ingestInbound(input, { cursor: "100" });
		assert.equal(res1.jobQueued, true);

		// Second delivery (e.g. catchUp)
		const res2 = await runtime.ingestInbound(input, { cursor: "100" });
		assert.equal(res2.jobQueued, false);
		assert.equal(res2.record.recordId, res1.record.recordId);

		const status = runtime.getStatus();
		assert.equal(status.queueLength, 1);

		const job = runtime.beginNextJob();
		assert.ok(job);
		assert.equal(job.triggerMessageId, "msg-duplicate-1");

		assert.equal(runtime.beginNextJob(), undefined);

		await runtime.disconnect();
	} finally {
		await cleanup();
	}
});
