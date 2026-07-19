export interface AccessPolicy {
	/** If set, only these Discord user IDs may trigger the bot. */
	allowedUserIds?: string[];
	/** If set, the triggering user must have at least one of these role IDs. */
	allowedRoleIds?: string[];
	/** Ignore messages from other bots. Defaults to true. */
	ignoreBots?: boolean;
}

export interface DiscordAccountConfig {
	botToken: string;
	/** The bot's user ID — same as the application's "Application ID" in the Developer Portal. */
	botUserId: string;
	/** Channel where new session threads are created. */
	parentChannelId: string;
	/** Cosmetic only — shown to the model in the system prompt. */
	serverName?: string;
	access?: AccessPolicy;
	threadAutoArchiveMinutes?: number;
}

export interface ChatConfig {
	accounts: Record<string, DiscordAccountConfig>;
}

export interface ResolvedThread {
	accountId: string;
	account: DiscordAccountConfig;
	threadId: string;
	threadName: string;
	conversationId: string;
	access: AccessPolicy;
	threadDir: string;
	workspaceDir: string;
	filesDir: string;
	logPath: string;
	lockPath: string;
}

export type AttachmentKind = "image" | "file" | "audio" | "video";

export interface AttachmentInput {
	path: string;
	name?: string;
	kind?: AttachmentKind;
	mimeType?: string;
	remoteUrl?: string;
}

export interface StoredAttachment {
	kind: AttachmentKind;
	name: string;
	mimeType?: string;
	size?: number;
	remoteUrl?: string;
	originalPath?: string;
	localPath: string;
}

export interface InboundMessageInput {
	messageId?: string;
	userId: string;
	userName?: string;
	roleIds?: string[];
	text: string;
	isBot?: boolean;
	attachments?: AttachmentInput[];
}

interface ChatRecordBase {
	recordId: number;
	timestamp: string;
}

export interface InboundMessageRecord extends ChatRecordBase {
	type: "inbound";
	messageId: string;
	userId: string;
	userName?: string;
	roleIds?: string[];
	text: string;
	isBot: boolean;
	attachments: StoredAttachment[];
}
export interface OutboundMessageRecord extends ChatRecordBase {
	type: "outbound";
	messageId: string;
	text: string;
	replyToMessageId?: string;
	jobId: string;
	attachments?: string[];
}
export interface CheckpointRecord extends ChatRecordBase {
	type: "checkpoint";
	cursor?: string;
}
export interface JobQueuedRecord extends ChatRecordBase {
	type: "job_queued";
	jobId: string;
	triggerRecordId: number;
}
export interface JobCompletedRecord extends ChatRecordBase {
	type: "job_completed";
	jobId: string;
	triggerRecordId: number;
	outboundRecordId?: number;
}
export interface JobFailedRecord extends ChatRecordBase {
	type: "job_failed";
	jobId: string;
	triggerRecordId: number;
	error: string;
}
export interface ErrorRecord extends ChatRecordBase {
	type: "error";
	message: string;
}

export type ChatLogRecord =
	| InboundMessageRecord
	| OutboundMessageRecord
	| CheckpointRecord
	| JobQueuedRecord
	| JobCompletedRecord
	| JobFailedRecord
	| ErrorRecord;

export interface PendingJob {
	jobId: string;
	triggerRecordId: number;
	queuedRecordId: number;
}

export interface DispatchableJob {
	job: PendingJob;
	prompt: string;
	triggerMessageId?: string;
}

export interface ConversationStatus {
	conversationId: string;
	conversationName: string;
	queueLength: number;
	hasActiveJob: boolean;
	recordCount: number;
	lastRecordId: number;
}

export interface LiveConnectionHandlers {
	onMessage(input: InboundMessageInput, checkpoint?: { cursor?: string }): Promise<void>;
	onCaughtUp(): Promise<void>;
	onError(error: Error): Promise<void>;
	onDisconnect?(): Promise<void>;
}

export interface LiveConnection {
	thread: ResolvedThread;
	disconnect(): Promise<void>;
	sendImmediate(text: string, replyToMessageId?: string): Promise<string | undefined>;
	send(text: string, attachmentPaths?: string[], signal?: AbortSignal, replyToMessageId?: string): Promise<string | undefined>;
	startTyping(): Promise<void>;
	stopTyping(): Promise<void>;
	/** Update (or create) the single live tool-status line for the in-flight turn. */
	setToolStatus(line: string): Promise<void>;
	/** Remove the tool-status line once the turn finishes. */
	clearToolStatus(): Promise<void>;
}
