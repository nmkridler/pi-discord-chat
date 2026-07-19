import { appendFile, copyFile, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

import type { AttachmentInput, ChatLogRecord, InboundMessageInput, ResolvedThread, StoredAttachment } from "./types.js";

function guessAttachmentKind(path: string, mimeType?: string): StoredAttachment["kind"] {
	const mime = mimeType?.toLowerCase() || "";
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("video/")) return "video";
	const ext = extname(path).toLowerCase();
	if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
	if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) return "audio";
	if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
	return "file";
}

export function guessMimeType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	if (ext === ".mp3") return "audio/mpeg";
	if (ext === ".wav") return "audio/wav";
	if (ext === ".ogg") return "audio/ogg";
	if (ext === ".mp4") return "video/mp4";
	if (ext === ".mov") return "video/quicktime";
	if (ext === ".webm") return "video/webm";
	if (ext === ".pdf") return "application/pdf";
	if (ext === ".json") return "application/json";
	if (ext === ".md") return "text/markdown";
	if (ext === ".txt" || ext === ".log") return "text/plain";
	return undefined;
}

function sanitizeFileName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isInside(root: string, value: string): boolean {
	const rel = relative(resolve(root), resolve(value));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export async function ensureThreadDirs(thread: ResolvedThread): Promise<void> {
	await mkdir(thread.threadDir, { recursive: true });
	await mkdir(thread.workspaceDir, { recursive: true });
	await mkdir(thread.filesDir, { recursive: true });
}

export async function readThreadLog(thread: ResolvedThread): Promise<ChatLogRecord[]> {
	try {
		const content = await readFile(thread.logPath, "utf8");
		return content
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ChatLogRecord)
			.sort((a, b) => a.recordId - b.recordId);
	} catch {
		return [];
	}
}

export async function appendThreadRecord(thread: ResolvedThread, record: ChatLogRecord): Promise<void> {
	await ensureThreadDirs(thread);
	await appendFile(thread.logPath, `${JSON.stringify(record)}\n`, "utf8");
}

function extractOwnerPid(owner: string): number | undefined {
	const match = owner.match(/^pi-discord-chat-(\d+)-/);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isFinite(pid) ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : undefined;
		return code === "EPERM";
	}
}

export async function acquireThreadLock(thread: ResolvedThread, owner: string): Promise<void> {
	await ensureThreadDirs(thread);
	try {
		const handle = await open(thread.lockPath, "wx");
		try {
			await handle.writeFile(`${owner}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : undefined;
		if (code !== "EEXIST") throw error;
	}
	const existingOwner = (await readFile(thread.lockPath, "utf8")).trim();
	const existingPid = extractOwnerPid(existingOwner);
	if (existingPid !== undefined && !isPidAlive(existingPid)) {
		await unlink(thread.lockPath).catch(() => undefined);
		const handle = await open(thread.lockPath, "wx");
		try {
			await handle.writeFile(`${owner}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return;
	}
	throw new Error(`Thread is already locked by ${existingOwner || "another pi-discord-chat worker"}`);
}

export async function releaseThreadLock(thread: ResolvedThread): Promise<void> {
	await unlink(thread.lockPath).catch(() => undefined);
}

export async function materializeAttachments(
	thread: ResolvedThread,
	messageId: string,
	attachments: AttachmentInput[] | undefined,
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];
	await ensureThreadDirs(thread);
	const stored: StoredAttachment[] = [];
	for (const [index, attachment] of attachments.entries()) {
		const fileStats = await lstat(attachment.path);
		if (!fileStats.isFile()) throw new Error(`Attachment is not a regular file: ${attachment.path}`);
		const fileName = sanitizeFileName(attachment.name || basename(attachment.path));
		const targetPath = isInside(thread.filesDir, attachment.path)
			? attachment.path
			: join(thread.filesDir, `${Date.now()}-${messageId}-${index + 1}-${fileName}`);
		if (targetPath !== attachment.path) await copyFile(attachment.path, targetPath);
		stored.push({
			kind: attachment.kind || guessAttachmentKind(attachment.path, attachment.mimeType),
			name: fileName,
			mimeType: attachment.mimeType || guessMimeType(attachment.path),
			size: fileStats.size,
			remoteUrl: attachment.remoteUrl,
			originalPath: targetPath === attachment.path ? undefined : attachment.path,
			localPath: targetPath,
		});
	}
	return stored;
}

export function buildBaseRecordFields(recordId: number) {
	return { recordId, timestamp: new Date().toISOString() };
}

export function nextMessageId(): string {
	return `discord-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeInboundMessage(input: InboundMessageInput): InboundMessageInput {
	return { ...input, text: input.text.trim(), isBot: input.isBot ?? false };
}

export async function readLocalAttachment(path: string): Promise<{ name: string; data: Uint8Array; mimeType?: string }> {
	const fileStats = await lstat(path);
	if (!fileStats.isFile()) throw new Error(`Attachment is not a regular file: ${path}`);
	return {
		name: basename(path),
		data: new Uint8Array(await readFile(path)),
		mimeType: guessMimeType(path),
	};
}
