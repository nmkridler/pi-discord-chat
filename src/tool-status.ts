const EMOJI: Record<string, string> = {
	bash: "💻",
	read: "📖",
	write: "📝",
	edit: "✏️",
	grep: "🔍",
	find: "🔎",
	ls: "📂",
	chat_attach: "📎",
};

function truncate(value: string, max = 80): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** One concise emoji + summary line for a tool call, for a live Discord status message. */
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
	const emoji = EMOJI[toolName] ?? "🔧";
	switch (toolName) {
		case "bash":
			return `${emoji} \`${truncate(str(input.command))}\``;
		case "read":
		case "write":
		case "edit":
			return `${emoji} ${truncate(str(input.path))}`;
		case "grep": {
			const path = str(input.path);
			return `${emoji} \`${truncate(str(input.pattern))}\`${path ? ` in ${truncate(path)}` : ""}`;
		}
		case "find":
			return `${emoji} \`${truncate(str(input.pattern))}\``;
		case "ls":
			return `${emoji} ${truncate(str(input.path) || ".")}`;
		case "chat_attach": {
			const paths = Array.isArray(input.paths) ? input.paths : [];
			return `${emoji} queuing ${paths.length} file${paths.length === 1 ? "" : "s"}`;
		}
		default:
			return `${emoji} ${toolName}`;
	}
}
