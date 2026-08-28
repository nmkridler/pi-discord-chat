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
	JobCompletedRecord,
	JobQueuedRecord,
	OutboundMessageRecord,
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

export function isCursorNewer(candidate?: string, current?: string): boolean {
	if (!candidate) return false;
	if (!current) return true;
	if (candidate === current) return false;
	try {
		const candidateBig = BigInt(candidate);
		const currentBig = BigInt(current);
		return candidateBig > currentBig;
	} catch {
		return candidate.localeCompare(current) > 0;
	}
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
	private ingressQueue: Promise<unknown> = Promise.resolve();

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

		// Reconstruct unresolved jobs from the append-only record log
		const completedJobIds = new Set<string>();
		const failedJobIds = new Set<string>();
		const outboundByJobId = new Map<string, OutboundMessageRecord>();

		for (const record of this.records) {
			if (record.type === "job_completed") completedJobIds.add(record.jobId);
			else if (record.type === "job_failed") failedJobIds.add(record.jobId);
			else if (record.type === "outbound" && record.jobId) outboundByJobId.set(record.jobId, record);
		}

		const queuedRecords = this.records.filter((r): r is JobQueuedRecord => r.type === "job_queued");
		this.pendingJobs = [];

		for (const queued of queuedRecords) {
			if (completedJobIds.has(queued.jobId) || failedJobIds.has(queued.jobId)) {
				continue;
			}
			const outbound = outboundByJobId.get(queued.jobId);
			if (outbound) {
				// The outbound reply was sent to Discord and persisted to log,
				// but the process crashed before appending job_completed. Heal the log.
				const completedRecord: JobCompletedRecord = {
					type: "job_completed",
					...buildBaseRecordFields(this.nextRecordId),
					jobId: queued.jobId,
					triggerRecordId: queued.triggerRecordId,
					outboundRecordId: outbound.recordId,
				};
				await this.appendRecord(completedRecord);
				completedJobIds.add(queued.jobId);
				continue;
			}
			this.pendingJobs.push({
				jobId: queued.jobId,
				triggerRecordId: queued.triggerRecordId,
				queuedRecordId: queued.recordId,
			});
		}

		this.armedAfterRecordId = this.records.at(-1)?.recordId ?? 0;
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

	private hasJobForTrigger(triggerRecordId: number): boolean {
		return this.records.some(
			(record) =>
				(record.type === "job_queued" || record.type === "job_completed" || record.type === "job_failed") &&
				record.triggerRecordId === triggerRecordId,
		);
	}

	private async queueTrigger(record: InboundMessageRecord, recovery = false): Promise<boolean> {
		if (!this.isAllowedInput(record) || (!recovery && !this.shouldQueueTrigger(record.recordId)) || this.hasJobForTrigger(record.recordId))
			return false;
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
		return true;
	}

	/**
	 * Boundary for buildPrompt: trigger messages at or before this record id are
	 * already accounted for and must not be replayed into the next prompt. A
	 * failed/aborted job resolves its trigger message just as much as a completed
	 * one does -- /stop is the user saying "abandon that request", not "hold it
	 * for later" -- so both record types advance the boundary. Counting only
	 * job_completed left an aborted turn's trigger message sitting after the
	 * boundary forever, so it got bundled into every prompt from then on.
	 */
	private getLastResolvedTriggerRecordId(): number {
		let last = 0;
		for (const record of this.records) {
			if (record.type !== "job_completed" && record.type !== "job_failed") continue;
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
		let maxCursor: string | undefined;
		for (const record of this.records) {
			if (record.type === "checkpoint" && record.cursor) {
				if (isCursorNewer(record.cursor, maxCursor)) {
					maxCursor = record.cursor;
				}
			}
		}
		return { cursor: maxCursor };
	}

	async noteCheckpoint(checkpoint: { cursor?: string }): Promise<void> {
		if (!checkpoint.cursor) return;
		const current = this.getLastCheckpoint();
		if (!isCursorNewer(checkpoint.cursor, current.cursor)) return;
		await this.appendRecord({
			type: "checkpoint",
			...buildBaseRecordFields(this.nextRecordId),
			cursor: checkpoint.cursor,
		});
	}

	/**
	 * Enqueue an ingress operation into this thread's serialized ingress pipeline.
	 * Ensures messages, attachments, controls, and checkpoints execute in strict arrival order.
	 */
	enqueueIngress<T>(task: () => Promise<T>): Promise<T> {
		const result = this.ingressQueue.then(task, task);
		this.ingressQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async processInbound(
		input: InboundMessageInput,
		checkpoint?: { cursor?: string },
	): Promise<{ record: InboundMessageRecord; jobQueued: boolean }> {
		const normalized = normalizeInboundMessage(input);
		const messageId = normalized.messageId || nextMessageId();
		const existing = this.records.find(
			(record): record is InboundMessageRecord => record.type === "inbound" && record.messageId === messageId,
		);
		if (existing) {
			// If a crash happened after writing an inbound record but before its queue
			// record, Discord re-delivers it because the checkpoint was not advanced.
			// Claim that replay as the missing queue transition before checkpointing it.
			const checkpointWasNew = checkpoint?.cursor && isCursorNewer(checkpoint.cursor, this.getLastCheckpoint().cursor);
			const jobQueued = checkpointWasNew ? await this.queueTrigger(existing, true) : false;
			if (checkpoint) await this.noteCheckpoint(checkpoint);
			return { record: existing, jobQueued };
		}
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
		const jobQueued = await this.queueTrigger(record);
		// Advance the remote cursor only after a trigger has either been queued or
		// intentionally ignored. This keeps an interrupted queue transition replayable.
		if (checkpoint) await this.noteCheckpoint(checkpoint);
		return { record, jobQueued };
	}

	async ingestInbound(
		input: InboundMessageInput,
		checkpoint?: { cursor?: string },
	): Promise<{ record: InboundMessageRecord; jobQueued: boolean }> {
		return this.enqueueIngress(() => this.processInbound(input, checkpoint));
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
		const resolvedBoundary = this.getLastResolvedTriggerRecordId();
		const slice = this.records.filter(
			(record) => record.recordId > resolvedBoundary && record.recordId <= job.triggerRecordId && record.type === "inbound",
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

	/**
	 * Records a reply produced by pi outside an inbound Discord job, such as an
	 * async subagent completion. These replies still belong in the thread log,
	 * but must not be associated with (or resolve) a queued inbound job.
	 */
	async recordUnsolicitedOutbound(text: string, remoteMessageId?: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		await this.appendRecord({
			type: "outbound",
			...buildBaseRecordFields(this.nextRecordId),
			messageId: remoteMessageId || nextMessageId(),
			text: trimmed,
		});
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
