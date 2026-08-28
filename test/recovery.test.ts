import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationRuntime } from "../src/runtime.js";
import type { ResolvedThread } from "../src/types.js";

async function createTestThread(prefix = "pi-chat-test-"): Promise<{ thread: ResolvedThread; cleanup: () => Promise<void> }> {
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

test("recovers unresolved queued jobs after restart and dispatches them exactly once", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const owner1 = "pi-discord-chat-11111-owner1";
		const runtime1 = await ConversationRuntime.connect(thread, owner1);

		// Ingest a message that queues a job
		const { jobQueued, record } = await runtime1.ingestInbound(
			{
				messageId: "msg-1",
				userId: "user-1",
				userName: "Alice",
				text: "Hello, world!",
			},
			{ cursor: "msg-1" },
		);

		assert.equal(jobQueued, true);
		assert.equal(record.messageId, "msg-1");

		// Simulate crash before beginNextJob
		await runtime1.disconnect();

		// Reconnect in a new process instance
		const owner2 = "pi-discord-chat-22222-owner2";
		const runtime2 = await ConversationRuntime.connect(thread, owner2);

		const status = runtime2.getStatus();
		assert.equal(status.queueLength, 1);
		assert.equal(status.hasActiveJob, false);

		// Dispatch the recovered job
		const nextJob = runtime2.beginNextJob();
		assert.ok(nextJob);
		assert.match(nextJob.prompt, /Hello, world!/);
		assert.equal(nextJob.triggerMessageId, "msg-1");

		// Complete the job
		await runtime2.completeActiveJob("I hear you loud and clear", "reply-1");

		// Reconnect again and confirm no duplicate jobs
		await runtime2.disconnect();
		const owner3 = "pi-discord-chat-33333-owner3";
		const runtime3 = await ConversationRuntime.connect(thread, owner3);
		assert.equal(runtime3.getStatus().queueLength, 0);
		assert.equal(runtime3.beginNextJob(), undefined);
		await runtime3.disconnect();
	} finally {
		await cleanup();
	}
});

test("replays an inbound record left without a queue record after a crash", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const runtime1 = await ConversationRuntime.connect(thread, "pi-discord-chat-11111-owner1");

		// Simulate a crash immediately after persisting the inbound record, before
		// `job_queued` or its remote checkpoint could be appended.
		// @ts-expect-error accessing private method for fault injection
		await runtime1.appendRecord({
			type: "inbound",
			recordId: 1,
			timestamp: new Date().toISOString(),
			messageId: "msg-interrupted-ingest",
			userId: "user-1",
			userName: "Alice",
			text: "Do not lose this message",
			isBot: false,
			attachments: [],
		});
		await runtime1.disconnect();

		const runtime2 = await ConversationRuntime.connect(thread, "pi-discord-chat-22222-owner2");
		const replay = await runtime2.ingestInbound(
			{
				messageId: "msg-interrupted-ingest",
				userId: "user-1",
				userName: "Alice",
				text: "Do not lose this message",
			},
			{ cursor: "100" },
		);
		assert.equal(replay.jobQueued, true);

		const recovered = runtime2.beginNextJob();
		assert.ok(recovered);
		assert.match(recovered.prompt, /Do not lose this message/);
		await runtime2.completeActiveJob("Recovered", "reply-recovered");
		await runtime2.disconnect();
	} finally {
		await cleanup();
	}
});

test("recovers in-flight active job when crashed after beginNextJob", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const owner1 = "pi-discord-chat-11111-owner1";
		const runtime1 = await ConversationRuntime.connect(thread, owner1);

		await runtime1.ingestInbound(
			{
				messageId: "msg-1",
				userId: "user-1",
				userName: "Bob",
				text: "In-flight task",
			},
			{ cursor: "msg-1" },
		);

		// Begin the job so it becomes activeJob in memory
		const active = runtime1.beginNextJob();
		assert.ok(active);

		// Crash before completion/failure
		await runtime1.disconnect();

		// Restart
		const owner2 = "pi-discord-chat-22222-owner2";
		const runtime2 = await ConversationRuntime.connect(thread, owner2);
		assert.equal(runtime2.getStatus().queueLength, 1);

		const recovered = runtime2.beginNextJob();
		assert.ok(recovered);
		assert.match(recovered.prompt, /In-flight task/);

		await runtime2.failActiveJob("some error");
		await runtime2.disconnect();

		// Failed jobs are not re-queued after next restart
		const owner3 = "pi-discord-chat-33333-owner3";
		const runtime3 = await ConversationRuntime.connect(thread, owner3);
		assert.equal(runtime3.getStatus().queueLength, 0);
		await runtime3.disconnect();
	} finally {
		await cleanup();
	}
});

test("heals log and marks complete when crashed after outbound persisted but before job_completed", async () => {
	const { thread, cleanup } = await createTestThread();
	try {
		const owner1 = "pi-discord-chat-11111-owner1";
		const runtime1 = await ConversationRuntime.connect(thread, owner1);

		await runtime1.ingestInbound(
			{
				messageId: "msg-1",
				userId: "user-1",
				userName: "Carol",
				text: "Generate report",
			},
			{ cursor: "msg-1" },
		);

		const job = runtime1.beginNextJob();
		assert.ok(job);

		// Manually append outbound record without job_completed to simulate crash
		// @ts-expect-error accessing private method for test simulation
		await runtime1.appendRecord({
			type: "outbound",
			recordId: 4,
			timestamp: new Date().toISOString(),
			messageId: "out-1",
			text: "Report generated",
			replyToMessageId: "msg-1",
			jobId: job.job.jobId,
		});

		await runtime1.disconnect();

		// Restart
		const owner2 = "pi-discord-chat-22222-owner2";
		const runtime2 = await ConversationRuntime.connect(thread, owner2);
		// Should have healed the log and marked as resolved, not in pending queue
		assert.equal(runtime2.getStatus().queueLength, 0);
		assert.equal(runtime2.beginNextJob(), undefined);
		await runtime2.disconnect();
	} finally {
		await cleanup();
	}
});
