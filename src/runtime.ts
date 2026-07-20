import { randomUUID } from "node:crypto";

import {
	acquireThreadLock,
	appendThreadRecord,
	buildBaseRecordFields,
	ensureThreadDirs,
	materializeAttachments,
	nextMessageId,
	normalizeInboundMessage,
	readThreadLog,
	releaseThreadLock,
} from "./log.js";
import type {
	ChatLogRecord,
	ConversationStatus,
	DispatchableJob,
	InboundMessageInput,
	InboundMessageRecord,
	JobQueuedRecord,
	PendingJob,
	ResolvedThread,
} from "./types.js";

function formatTranscriptRecord(record: ChatLogRecord): string[] {
	if (record.type !== "inbound") return [];
	const lines = [`- [${record.timestamp}] [uid:${record.userId}] ${record.userName ?? "unknown"}: ${record.text || "(no text)"}`];
	if (record.attachments.length > 0) {
		lines.push("  attachments:");
		for (const attachment of record.attachments) {
			lines.push(`  - ${attachment.localPath}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`);
		}
	}
	return lines;
}

function getLatestTriggerRecord(records: ChatLogRecord[], job: PendingJob): InboundMessageRecord | undefined {
	const triggerRecord = records.find((record) => record.recordId === job.triggerRecordId);
	if (triggerRecord?.type !== "inbound") return undefined;
	return triggerRecord;
}

/**
 * Tracks the message/job queue for a single Discord thread and its on-disk log.
 * Every non-bot message in the thread triggers a turn — once a thread exists,
 * no further @mention is required (see runtime.parseControlCommand for the
 * plain-text stop/new/compact/status controls).
 */
export class ConversationRuntime {
	readonly thread: ResolvedThread;
	private readonly ownerId: string;
	private records: ChatLogRecord[] = [];
	private nextRecordId = 1;
	private pendingJobs: PendingJob[] = [];
	private activeJob: PendingJob | undefined;
	private armedAfterRecordId: number | undefined;

	constructor(thread: ResolvedThread, ownerId: string) {
		this.thread = thread;
		this.ownerId = ownerId;
	}

	static async connect(thread: ResolvedThread, ownerId: string): Promise<ConversationRuntime> {
		const runtime = new ConversationRuntime(thread, ownerId);
		await runtime.initialize();
		return runtime;
	}

	private async initialize(): Promise<void> {
		await ensureThreadDirs(this.thread);
		await acquireThreadLock(this.thread, this.ownerId);
		this.records = await readThreadLog(this.thread);
		this.nextRecordId = this.records.reduce((max, record) => Math.max(max, record.recordId), 0) + 1;
		// A brand-new thread (e.g. just spawned from an @mention) has no log yet: arm
		// immediately so the catch-up fetch that replays its starter message queues a
		// job for it, instead of waiting for a message after catch-up to trigger a turn.
		if (this.records.length === 0) this.armAfterCurrentTail();
	}

	/**
	 * Marks the current log tail as caught up. Messages ingested before this call
	 * (i.e. history replayed on connect) are recorded but never queued as jobs —
	 * only messages that arrive after catch-up trigger a turn.
	 */
	armAfterCurrentTail(): void {
		this.armedAfterRecordId = this.records.at(-1)?.recordId ?? 0;
	}

	private shouldQueueTrigger(recordId: number): boolean {
		if (this.armedAfterRecordId === undefined) return false;
		return recordId > this.armedAfterRecordId;
	}

	async disconnect(): Promise<void> {
		await releaseThreadLock(this.thread);
	}

	private async appendRecord(record: ChatLogRecord): Promise<void> {
		this.records.push(record);
		this.nextRecordId = Math.max(this.nextRecordId, record.recordId + 1);
		await appendThreadRecord(this.thread, record);
	}

	private getLastCompletedTriggerRecordId(): number {
		let last = 0;
		for (const record of this.records) {
			if (record.type !== "job_completed") continue;
			last = Math.max(last, record.triggerRecordId);
		}
		return last;
	}

	private isAllowedInput(message: Pick<InboundMessageInput, "userId" | "roleIds" | "isBot">): boolean {
		const access = this.thread.access;
		if ((message.isBot ?? false) && (access.ignoreBots ?? true)) return false;
		if (access.allowedUserIds?.length && !access.allowedUserIds.includes(message.userId)) return false;
		if (access.allowedRoleIds?.length) {
			const roleIds = message.roleIds ?? [];
			if (!roleIds.some((roleId) => access.allowedRoleIds?.includes(roleId))) return false;
		}
		return true;
	}

	parseControlCommand(
		input: InboundMessageInput,
	): "stop" | "clear" | "status" | { type: "model"; name: string } | { type: "compact"; instructions?: string } | undefined {
		if (!this.isAllowedInput(input)) return undefined;
		const command = input.text.trim();
		const lower = command.replace(/\s+/g, " ").toLowerCase();
		if (lower === "stop" || lower === "/stop") return "stop";
		// "new" is kept as an alias: pi cannot start a session from an extension event
		// handler, and clearing the context is what people mean by it anyway.
		if (lower === "clear" || lower === "/clear" || lower === "new" || lower === "/new") return "clear";
		if (lower === "status" || lower === "/status") return "status";
		if (lower === "compact" || lower === "/compact") return { type: "compact" };

		if (lower.startsWith("model ") || lower.startsWith("/model ")) {
			const parts = command.split(/\s+/);
			if (parts.length >= 2) {
				return { type: "model", name: parts[1] };
			}
		}

		if (lower.startsWith("compact ") || lower.startsWith("/compact ")) {
			const instructions = command.replace(/^\/?compact\s+/i, "").trim();
			if (instructions) return { type: "compact", instructions };
		}

		return undefined;
	}

	getLastCheckpoint(): { cursor?: string } {
		for (let index = this.records.length - 1; index >= 0; index--) {
			const record = this.records[index];
			if (record?.type === "checkpoint") return { cursor: record.cursor };
		}
		return {};
	}

	async noteCheckpoint(checkpoint: { cursor?: string }): Promise<void> {
		const previous = this.getLastCheckpoint();
		if (previous.cursor === checkpoint.cursor) return;
		await this.appendRecord({
			type: "checkpoint",
			...buildBaseRecordFields(this.nextRecordId),
			cursor: checkpoint.cursor,
		});
	}

	async ingestInbound(
		input: InboundMessageInput,
		checkpoint?: { cursor?: string },
	): Promise<{ record: InboundMessageRecord; jobQueued: boolean }> {
		const normalized = normalizeInboundMessage(input);
		const messageId = normalized.messageId || nextMessageId();
		const attachments = await materializeAttachments(this.thread, messageId, normalized.attachments);
		const record: InboundMessageRecord = {
			type: "inbound",
			...buildBaseRecordFields(this.nextRecordId),
			messageId,
			userId: normalized.userId,
			userName: normalized.userName,
			roleIds: normalized.roleIds,
			text: normalized.text,
			isBot: normalized.isBot ?? false,
			attachments,
		};
		await this.appendRecord(record);
		if (checkpoint) await this.noteCheckpoint(checkpoint);
		if (!this.isAllowedInput(record) || !this.shouldQueueTrigger(record.recordId)) return { record, jobQueued: false };
		const queuedRecord: JobQueuedRecord = {
			type: "job_queued",
			...buildBaseRecordFields(this.nextRecordId),
			jobId: randomUUID(),
			triggerRecordId: record.recordId,
		};
		await this.appendRecord(queuedRecord);
		this.pendingJobs.push({
			jobId: queuedRecord.jobId,
			triggerRecordId: queuedRecord.triggerRecordId,
			queuedRecordId: queuedRecord.recordId,
		});
		return { record, jobQueued: true };
	}

	beginNextJob(): DispatchableJob | undefined {
		if (this.activeJob || this.pendingJobs.length === 0) return undefined;
		const job = this.pendingJobs.shift();
		if (!job) return undefined;
		this.activeJob = job;
		const triggerRecord = getLatestTriggerRecord(this.records, job);
		return {
			job,
			prompt: this.buildPrompt(job),
			triggerMessageId: triggerRecord?.messageId,
		};
	}

	private buildPrompt(job: PendingJob): string {
		const completedBoundary = this.getLastCompletedTriggerRecordId();
		const slice = this.records.filter(
			(record) => record.recordId > completedBoundary && record.recordId <= job.triggerRecordId && record.type === "inbound",
		);
		const lines: string[] = [];
		for (const record of slice) lines.push(...formatTranscriptRecord(record));
		return lines.join("\n").trim();
	}

	async completeActiveJob(text: string, remoteMessageId?: string, attachmentPaths?: string[]): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		let outboundRecordId: number | undefined;
		const trimmed = text.trim();
		if (trimmed.length > 0 || (attachmentPaths?.length ?? 0) > 0) {
			const triggerRecord = getLatestTriggerRecord(this.records, job);
			const outbound = {
				type: "outbound",
				...buildBaseRecordFields(this.nextRecordId),
				messageId: remoteMessageId || nextMessageId(),
				text: trimmed,
				replyToMessageId: triggerRecord?.messageId,
				jobId: job.jobId,
				attachments: attachmentPaths?.length ? [...attachmentPaths] : undefined,
			} as const;
			outboundRecordId = outbound.recordId;
			await this.appendRecord(outbound);
		}
		await this.appendRecord({
			type: "job_completed",
			...buildBaseRecordFields(this.nextRecordId),
			jobId: job.jobId,
			triggerRecordId: job.triggerRecordId,
			outboundRecordId,
		});
		this.activeJob = undefined;
	}

	async failActiveJob(error: string): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		await this.appendRecord({
			type: "job_failed",
			...buildBaseRecordFields(this.nextRecordId),
			jobId: job.jobId,
			triggerRecordId: job.triggerRecordId,
			error,
		});
		this.activeJob = undefined;
	}

	async appendError(message: string): Promise<void> {
		await this.appendRecord({
			type: "error",
			...buildBaseRecordFields(this.nextRecordId),
			message,
		});
	}

	getStatus(): ConversationStatus {
		return {
			conversationId: this.thread.conversationId,
			conversationName: `${this.thread.accountId}/${this.thread.threadName}`,
			queueLength: this.pendingJobs.length,
			hasActiveJob: this.activeJob !== undefined,
			recordCount: this.records.length,
			lastRecordId: this.records.at(-1)?.recordId ?? 0,
		};
	}
}
