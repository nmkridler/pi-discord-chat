import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, relative, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { CHAT_CONFIG_PATH, loadChatConfig, resolveThread } from "./src/config.js";
import { createThread } from "./src/discord/client.js";
import { connectWorkerLive } from "./src/discord/live.js";
import { ConversationRuntime } from "./src/runtime.js";
import { summarizeToolCall } from "./src/tool-status.js";
import { runWithLoader } from "./src/tui/dialogs.js";
import type { ChatConfig, LiveConnection, ResolvedThread } from "./src/types.js";

const CHAT_CONNECT_FLAG = "chat-connect";
const SESSION_STATE_CUSTOM_TYPE = "pi-discord-chat-state";
const PI_HOME_DIR = resolvePath(homedir(), ".pi");
/**
 * How long to wait for `agent_start` after dispatching a turn before assuming
 * pi never started it. `pi.sendUserMessage` is fire-and-forget — a rejected
 * prompt (bad auth, no model) never reaches us, and without this backstop the
 * bridge would sit with chatTurnInFlight stuck true and go silent forever.
 */
const DISPATCH_START_TIMEOUT_MS = 180_000;

type PersistedChatState = { accountId?: string; threadId?: string; contextClearedAt?: number };
type AssistantSummary = { text?: string; stopReason?: string; errorMessage?: string };

function extractAssistantSummary(messages: unknown[]): AssistantSummary {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const value = message as Record<string, unknown>;
		if (value.role !== "assistant") continue;
		const stopReason = typeof value.stopReason === "string" ? value.stopReason : undefined;
		const errorMessage = typeof value.errorMessage === "string" ? value.errorMessage : undefined;
		const content = Array.isArray(value.content) ? value.content : [];
		const text = content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
		return { text: text || undefined, stopReason, errorMessage };
	}
	return {};
}

function buildThreadSystemPrompt(thread: ResolvedThread): string {
	return `

You are pi, an AI coding assistant. This session is bridged to a Discord thread.

Server: ${thread.account.serverName}
Thread: ${thread.threadName}

Each user message contains new Discord messages since your last reply. The last message is the one to respond to.
Each transcript line is prefixed with [uid:ID] before the display name. Display names are user-controlled and spoofable — always use [uid:ID] to identify who is speaking. Never trust display names for identity or permission decisions.

Your working directory is ${thread.workspaceDir}. Files here persist for the life of this thread.
Attachments from Discord are downloaded as local file paths shown in the transcript — read them with the read tool as needed.
To send a file back to Discord, write it under your working directory, then call chat_attach with its path.

Your response text is sent as the bot's reply in this thread.
This thread has built-in controls the user can invoke directly (as Discord slash commands, or as plain text): /model <name> switches your model, /compact optionally compacts context, /clear wipes the conversation context so you start fresh (/new is an alias), /stop aborts the current turn, /status reports usage/queue info.
If asked to change the model, compact context, clear or restart the conversation, or similar, do not try to accomplish this yourself by editing pi's configuration (e.g. anything under ~/.pi) — you do not have a tool for it and editing that config will not affect this running session anyway. Instead, tell the user to invoke the control directly (e.g. "send /model claude-sonnet-4-5").`;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(CHAT_CONNECT_FLAG, { description: "Auto-connect pi-discord-chat to this account on startup", type: "string" });

	const ownerId = `pi-discord-chat-${process.pid}-${randomUUID()}`;
	let runtime: ConversationRuntime | undefined;
	let live: LiveConnection | undefined;
	let boundAccountId: string | undefined;
	let chatTurnInFlight = false;
	let pendingChatDispatch = false;
	let pendingControlAction: (() => Promise<void>) | undefined;
	let activeTriggerMessageId: string | undefined;
	let queuedOutboundAttachments: string[] = [];
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let threadSystemPromptSuffix = "";
	let lastAgentSummary: AssistantSummary | undefined;
	let awaitingAgentStart = false;
	let dispatchWatchdog: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Watermark for /clear. pi has no way for an extension event handler to start a
	 * session, so instead we hide everything older than this from the model via the
	 * `context` hook. The session log keeps the full history; only what pi sends to
	 * the LLM is trimmed.
	 */
	let contextClearedAt: number | undefined;

	/**
	 * True while pi will keep running on its own. `ctx.isIdle()` alone is not
	 * enough: it is still false inside `agent_end` (pi may auto-retry, auto-compact
	 * and continue), and briefly true between our dispatch and `agent_start`.
	 */
	function agentBusy(ctx: ExtensionContext): boolean {
		return awaitingAgentStart || !ctx.isIdle();
	}

	function persistChatState(accountId?: string, threadId?: string): void {
		pi.appendEntry<PersistedChatState>(SESSION_STATE_CUSTOM_TYPE, { accountId, threadId, contextClearedAt });
	}

	function getPersistedChatState(ctx: ExtensionContext): PersistedChatState | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index] as unknown as Record<string, unknown>;
			if (entry.type !== "custom" || entry.customType !== SESSION_STATE_CUSTOM_TYPE) continue;
			return entry.data as PersistedChatState | undefined;
		}
		return undefined;
	}

	function startTypingLoop(): void {
		if (!live || typingInterval) return;
		void live.startTyping();
		typingInterval = setInterval(() => void live?.startTyping(), 4000);
	}
	function stopTypingLoop(): void {
		if (typingInterval) {
			clearInterval(typingInterval);
			typingInterval = undefined;
		}
		void live?.stopTyping();
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "discord-chat");
		if (error) {
			ctx.ui.setStatus("chat", `${label} ${theme.fg("error", error)}`);
			return;
		}
		if (!runtime) {
			ctx.ui.setStatus("chat", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		const status = runtime.getStatus();
		const details = [status.conversationName];
		if (status.hasActiveJob) details.push("active");
		if (status.queueLength > 0) details.push(`q:${status.queueLength}`);
		ctx.ui.setStatus("chat", `${label} ${theme.fg("success", details.join(" | "))}`);
	}

	pi.registerMessageRenderer("chat-context", (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", theme.bold("[pi-discord-chat]"))} ${String(message.content)}`, 0, 0));
		return box;
	});

	function clearDispatchWatchdog(): void {
		if (dispatchWatchdog) {
			clearTimeout(dispatchWatchdog);
			dispatchWatchdog = undefined;
		}
	}

	function armDispatchWatchdog(ctx: ExtensionContext): void {
		clearDispatchWatchdog();
		dispatchWatchdog = setTimeout(() => {
			dispatchWatchdog = undefined;
			if (!awaitingAgentStart) return;
			// A pre-prompt auto-compaction can delay agent_start well past the timeout.
			// Only give up once pi is genuinely doing nothing.
			if (!ctx.isIdle()) {
				armDispatchWatchdog(ctx);
				return;
			}
			awaitingAgentStart = false;
			void recoverStalledDispatch(ctx);
		}, DISPATCH_START_TIMEOUT_MS);
	}

	/** Last resort: pi never started the turn we dispatched, so unwind it ourselves. */
	async function recoverStalledDispatch(ctx: ExtensionContext): Promise<void> {
		const message = "pi never started the turn (the prompt was rejected)";
		pendingChatDispatch = false;
		chatTurnInFlight = false;
		stopTypingLoop();
		if (runtime) await runtime.failActiveJob(message).catch(() => undefined);
		await live?.sendImmediate(`⚠️ pi-discord-chat: ${message}`).catch(() => undefined);
		await runPendingControlAction();
		updateStatus(ctx, message);
		await tryDispatch(ctx);
	}

	async function runPendingControlAction(): Promise<void> {
		const action = pendingControlAction;
		pendingControlAction = undefined;
		if (action) await action();
	}

	async function tryDispatch(ctx: ExtensionContext): Promise<void> {
		if (!runtime || chatTurnInFlight || agentBusy(ctx)) return;
		const next = runtime.beginNextJob();
		if (!next) {
			updateStatus(ctx);
			return;
		}
		try {
			chatTurnInFlight = true;
			activeTriggerMessageId = next.triggerMessageId;
			queuedOutboundAttachments = [];
			pendingChatDispatch = true;
			awaitingAgentStart = true;
			armDispatchWatchdog(ctx);
			startTypingLoop();
			pi.sendUserMessage(next.prompt);
			updateStatus(ctx);
		} catch (error) {
			pendingChatDispatch = false;
			chatTurnInFlight = false;
			awaitingAgentStart = false;
			clearDispatchWatchdog();
			stopTypingLoop();
			const message = error instanceof Error ? error.message : String(error);
			await runtime.failActiveJob(`dispatch failed: ${message}`);
			updateStatus(ctx, message);
		}
	}

	async function loadConfigOrNotify(ctx: ExtensionContext): Promise<ChatConfig | undefined> {
		try {
			return await loadChatConfig();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return undefined;
		}
	}

	async function connectToThread(ctx: ExtensionContext, accountId: string, threadId: string, threadName?: string): Promise<boolean> {
		const config = await loadConfigOrNotify(ctx);
		if (!config) return false;
		const thread = resolveThread(config, accountId, threadId, threadName);
		if (!thread) {
			ctx.ui.notify(`Unknown account: ${accountId}`, "error");
			return false;
		}
		try {
			runtime = await ConversationRuntime.connect(thread, ownerId);
			live = await connectWorkerLive(
				thread,
				{
					onMessage: async (input, checkpoint) => {
						if (!runtime) return;
						const control = runtime.parseControlCommand(input);
						if (control === "stop") {
							if (agentBusy(ctx)) {
								ctx.abort();
								await live?.sendImmediate("Aborted current turn.");
							} else {
								// Nothing is running: clear any stale in-flight bookkeeping so the
								// queue can drain instead of staying wedged.
								chatTurnInFlight = false;
								await live?.sendImmediate("No active turn.");
								await tryDispatch(ctx);
							}
							return;
						}
						if (typeof control === "object" && control.type === "compact") {
							const customInstructions = control.instructions;
							const runCompact = async () => {
								ctx.compact({
									customInstructions,
									onComplete: () => {
										void live?.sendImmediate("Compaction completed.");
										void tryDispatch(ctx);
									},
									onError: (error) => {
										void live?.sendImmediate(`Compaction failed: ${error.message}`);
										void tryDispatch(ctx);
									},
								});
								await live?.sendImmediate("Compaction started.");
							};
							if (agentBusy(ctx)) {
								pendingControlAction = runCompact;
								ctx.abort();
								await live?.sendImmediate("Aborting current turn, then compacting.");
							} else {
								chatTurnInFlight = false;
								await runCompact();
							}
							return;
						}
						if (control === "clear") {
							const runClear = async () => {
								// Cut only between turns: mid-turn this could orphan a toolResult
								// whose toolUse got filtered out, which some providers reject.
								contextClearedAt = Date.now();
								persistChatState(boundAccountId, runtime?.thread.threadId);
								await live?.sendImmediate("Context cleared. Starting fresh — I no longer remember this thread's earlier messages.");
							};
							if (agentBusy(ctx)) {
								pendingControlAction = runClear;
								ctx.abort();
								await live?.sendImmediate("Aborting current turn, then clearing context.");
							} else {
								chatTurnInFlight = false;
								await runClear();
								await tryDispatch(ctx);
							}
							return;
						}
						if (control === "status") {
							const status = runtime.getStatus();
							await live?.sendImmediate(
								`Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "?"}\nQueue: ${status.queueLength}${status.hasActiveJob ? " (active)" : ""}`,
							);
							return;
						}
						if (typeof control === "object" && control.type === "model") {
							const modelQuery = control.name.toLowerCase();
							const models = ctx.modelRegistry.getAll();
							const model = models.find(
								(m) => m.id.toLowerCase() === modelQuery || `${m.provider.toLowerCase()}/${m.id.toLowerCase()}` === modelQuery,
							);
							if (model) {
								const success = await pi.setModel(model);
								if (success) {
									await live?.sendImmediate(`✅ Model changed to \`${model.provider}/${model.id}\``);
								} else {
									await live?.sendImmediate(`❌ Failed to change model to \`${model.provider}/${model.id}\` (check API keys)`);
								}
							} else {
								const sample = models
									.map((m) => m.id)
									.slice(0, 5)
									.join(", ");
								await live?.sendImmediate(`❌ Model not found: \`${control.name}\`\nAvailable models include: ${sample}...`);
							}
							return;
						}
						await runtime.ingestInbound(input, checkpoint);
						await tryDispatch(ctx);
					},
					onCaughtUp: async () => runtime?.armAfterCurrentTail(),
					onError: async (error) => {
						if (runtime) await runtime.appendError(error.message);
						updateStatus(ctx, error.message);
					},
					onDisconnect: async () => {
						updateStatus(ctx, "disconnected, reconnecting...");
						if (live) {
							await live.disconnect().catch(() => undefined);
							live = undefined;
						}
						await connectToThread(ctx, accountId, threadId, threadName);
					},
				},
				runtime.getLastCheckpoint().cursor,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (runtime) await runtime.disconnect().catch(() => undefined);
			runtime = undefined;
			updateStatus(ctx, message);
			ctx.ui.notify(`Connect error: ${message}`, "error");
			return false;
		}
		boundAccountId = accountId;
		threadSystemPromptSuffix = buildThreadSystemPrompt(thread);
		// Carry the /clear watermark across reconnects, so a dropped gateway
		// connection does not resurrect history the user already cleared.
		contextClearedAt = getPersistedChatState(ctx)?.contextClearedAt ?? contextClearedAt;
		persistChatState(accountId, threadId);
		pi.sendMessage({ customType: "chat-context", content: `Connected to Discord thread "${thread.threadName}".`, display: true });
		updateStatus(ctx);
		await tryDispatch(ctx);
		return true;
	}

	async function ensureConnected(ctx: ExtensionContext, accountIdArg?: string): Promise<boolean> {
		const config = await loadConfigOrNotify(ctx);
		if (!config) return false;
		const persisted = getPersistedChatState(ctx);
		const accountId = accountIdArg || persisted?.accountId || Object.keys(config.accounts)[0];
		if (!accountId || !config.accounts[accountId]) {
			ctx.ui.notify(`No configured account. Add one to ${CHAT_CONFIG_PATH} — see the pi-discord-chat README.`, "warning");
			return false;
		}
		const persistedThreadId = persisted?.accountId === accountId ? persisted.threadId : undefined;
		if (persistedThreadId) return connectToThread(ctx, accountId, persistedThreadId);

		const account = config.accounts[accountId];
		const name = basename(ctx.cwd) || "pi session";
		const created = await runWithLoader(ctx, "Creating Discord thread...", () =>
			createThread(account.botToken, account.parentChannelId, name, account.threadAutoArchiveMinutes),
		);
		if (created.error || !created.value) {
			ctx.ui.notify(`Could not create Discord thread: ${created.error ?? "unknown error"}`, "error");
			return false;
		}
		return connectToThread(ctx, accountId, created.value.id, created.value.name);
	}

	async function disconnectAll(ctx: ExtensionContext): Promise<void> {
		clearDispatchWatchdog();
		awaitingAgentStart = false;
		chatTurnInFlight = false;
		pendingChatDispatch = false;
		pendingControlAction = undefined;
		lastAgentSummary = undefined;
		stopTypingLoop();
		if (live) {
			await live.disconnect().catch(() => undefined);
			live = undefined;
		}
		if (runtime) {
			await runtime.disconnect().catch(() => undefined);
			runtime = undefined;
		}
		updateStatus(ctx);
	}

	pi.registerTool({
		name: "chat_attach",
		label: "Chat Attach",
		description: "Queue one or more local files (from your working directory) to be sent with the next Discord reply.",
		promptSnippet: "Queue local files to be sent with the next Discord reply.",
		promptGuidelines: ["When the user asked for a file or generated artifact, use chat_attach with local file paths."],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: 10 }),
		}),
		renderCall(args, theme) {
			const files = Array.isArray(args.paths) ? args.paths : [];
			const preview = files.slice(0, 3).join(", ");
			const suffix = files.length > 3 ? ` +${files.length - 3} more` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("chat_attach"))} ${theme.fg("accent", preview || "(none)")}${theme.fg("dim", suffix)}`,
				0,
				0,
			);
		},
		async execute(_toolCallId, params, signal) {
			if (!chatTurnInFlight || !runtime) throw new Error("chat_attach can only be used while replying to an active chat turn");
			signal?.throwIfAborted?.();
			const workspaceDir = runtime.thread.workspaceDir;
			for (const path of params.paths) {
				const rel = relative(workspaceDir, resolvePath(workspaceDir, path));
				if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
					throw new Error(`chat_attach: path must be inside the working directory (${workspaceDir}): ${path}`);
				}
			}
			queuedOutboundAttachments.push(...params.paths.map((path) => resolvePath(workspaceDir, path)));
			return {
				content: [{ type: "text", text: `Queued ${params.paths.length} attachment(s).` }],
				details: { paths: params.paths },
			};
		},
	});

	function pathTouchesPiHome(path: string): boolean {
		const rel = relative(PI_HOME_DIR, resolvePath(path));
		return rel === "" || !rel.startsWith("..");
	}

	function commandTouchesPiHome(command: string): boolean {
		return command.includes(PI_HOME_DIR) || /(~|\$HOME)\/\.pi(\/|$)/.test(command);
	}

	const PI_HOME_BLOCK_REASON =
		"Refusing to touch pi's own configuration under ~/.pi — tell the user to use /model, /compact, /new, or /stop instead.";

	pi.on("tool_call", async (event) => {
		if (isToolCallEventType("write", event) && pathTouchesPiHome(event.input.path)) {
			return { block: true, reason: PI_HOME_BLOCK_REASON };
		}
		if (isToolCallEventType("edit", event) && pathTouchesPiHome(event.input.path)) {
			return { block: true, reason: PI_HOME_BLOCK_REASON };
		}
		if (isToolCallEventType("bash", event) && commandTouchesPiHome(event.input.command)) {
			return { block: true, reason: PI_HOME_BLOCK_REASON };
		}
		if (!chatTurnInFlight || !live) return;
		void live.setToolStatus(summarizeToolCall(event.toolName, event.input as Record<string, unknown>));
	});

	pi.on("before_agent_start", async (event) => {
		if (!pendingChatDispatch) return undefined;
		pendingChatDispatch = false;
		return { systemPrompt: event.systemPrompt + threadSystemPromptSuffix };
	});

	// Implements /clear: hide pre-watermark history from the model on every LLM call.
	// The new user message always survives the cut, so the model never sees an empty
	// context, and pi's own token accounting drops to match what we actually send.
	pi.on("context", async (event) => {
		const clearedAt = contextClearedAt;
		if (!clearedAt) return undefined;
		const kept = event.messages.filter((message) => {
			const timestamp = (message as { timestamp?: number }).timestamp;
			return typeof timestamp !== "number" || timestamp >= clearedAt;
		});
		return { messages: kept };
	});

	pi.on("agent_start", async () => {
		if (!awaitingAgentStart) return;
		awaitingAgentStart = false;
		clearDispatchWatchdog();
	});

	// agent_end can fire several times for one dispatched turn: pi may auto-retry,
	// auto-compact on overflow and continue, or drain queued follow-ups afterwards.
	// Only record what the run produced here; acting on it is agent_settled's job.
	pi.on("agent_end", async (event) => {
		lastAgentSummary = extractAssistantSummary(event.messages as unknown[]);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const summary = lastAgentSummary ?? {};
		lastAgentSummary = undefined;
		if (live) await live.clearToolStatus().catch(() => undefined);
		if (!runtime || !chatTurnInFlight) {
			stopTypingLoop();
			await runPendingControlAction();
			updateStatus(ctx);
			await tryDispatch(ctx);
			return;
		}
		if (summary.stopReason === "aborted") {
			stopTypingLoop();
			chatTurnInFlight = false;
			await runtime.failActiveJob("aborted");
			await runPendingControlAction();
			updateStatus(ctx);
			await tryDispatch(ctx);
			return;
		}
		if (summary.stopReason === "error" || summary.stopReason === "length") {
			stopTypingLoop();
			chatTurnInFlight = false;
			// "length" here means pi's own compact-and-retry already failed to recover.
			const errorMessage = summary.errorMessage || (summary.stopReason === "length" ? "ran out of context — send /compact" : "agent error");
			await runtime.failActiveJob(errorMessage);
			if (live) await live.sendImmediate(`⚠️ pi-discord-chat error: ${errorMessage}`).catch(() => undefined);
			await runPendingControlAction();
			updateStatus(ctx, errorMessage);
			await tryDispatch(ctx);
			return;
		}
		stopTypingLoop();
		let remoteMessageId: string | undefined;
		const attachmentPaths = [...queuedOutboundAttachments];
		queuedOutboundAttachments = [];
		const finalText = summary.text || (attachmentPaths.length > 0 ? "Attached requested file(s)." : "");
		if (live && finalText) {
			try {
				remoteMessageId = await live.send(finalText, attachmentPaths, ctx.signal, activeTriggerMessageId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				chatTurnInFlight = false;
				await runtime.failActiveJob(`send failed: ${message}`);
				await runPendingControlAction();
				updateStatus(ctx, message);
				await tryDispatch(ctx);
				return;
			}
		}
		chatTurnInFlight = false;
		await runtime.completeActiveJob(finalText, remoteMessageId, attachmentPaths);
		await runPendingControlAction();
		updateStatus(ctx);
		await tryDispatch(ctx);
	});

	pi.registerCommand("chat-connect", {
		description: "Bind this pi session to a Discord thread (creates one on first connect, reused after)",
		handler: async (args, ctx) => {
			await ensureConnected(ctx, args.trim() || undefined);
		},
	});

	pi.registerCommand("chat-new", {
		description: "Start a new pi session bound to the same Discord thread",
		handler: async (_args, ctx) => {
			const accountId = boundAccountId;
			const threadId = runtime?.thread.threadId;
			await ctx.newSession({
				setup: async (sm) => {
					if (accountId && threadId) sm.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, { accountId, threadId });
				},
			});
		},
	});

	pi.registerCommand("chat-disconnect", {
		description: "Disconnect pi-discord-chat in this session",
		handler: async (_args, ctx) => disconnectAll(ctx),
	});

	pi.registerCommand("chat-status", {
		description: "Show pi-discord-chat connection status",
		handler: async (_args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("Not connected.", "info");
				return;
			}
			const status = runtime.getStatus();
			ctx.ui.notify(`Thread: ${status.conversationName}\nQueue: ${status.queueLength}${status.hasActiveJob ? " (active)" : ""}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
		const flaggedAccountId = pi.getFlag(CHAT_CONNECT_FLAG);
		const persisted = getPersistedChatState(ctx);
		if ((typeof flaggedAccountId === "string" && flaggedAccountId.trim()) || persisted?.accountId) {
			await ensureConnected(ctx, typeof flaggedAccountId === "string" ? flaggedAccountId.trim() : undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await disconnectAll(ctx);
	});
}
