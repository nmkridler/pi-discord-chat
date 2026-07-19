import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { AttachmentInput, ResolvedThread } from "../types.js";

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessAttachmentKind(fileName: string, mimeType?: string): AttachmentInput["kind"] {
	const mime = mimeType?.toLowerCase() || "";
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("video/")) return "video";
	const ext = extname(fileName).toLowerCase();
	if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
	if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) return "audio";
	if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
	return "file";
}

export async function storeDownloadedAttachment(
	thread: ResolvedThread,
	messageId: string,
	index: number,
	fileName: string,
	data: Uint8Array,
	mimeType?: string,
	remoteUrl?: string,
): Promise<AttachmentInput> {
	await mkdir(thread.filesDir, { recursive: true });
	const safeName = sanitize(fileName || `attachment-${index}`);
	const targetPath = join(thread.filesDir, `incoming-${Date.now()}-${messageId}-${index}-${safeName}`);
	await writeFile(targetPath, data);
	return {
		path: targetPath,
		name: basename(targetPath),
		mimeType,
		kind: guessAttachmentKind(fileName, mimeType),
		remoteUrl,
	};
}
