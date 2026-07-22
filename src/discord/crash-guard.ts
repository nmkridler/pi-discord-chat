/**
 * Process-level guard against a self-healing crash in the Discord gateway layer.
 *
 * `@discordjs/ws` (via `ws`) can leave a raw WebSocket without an `'error'`
 * listener when a shard is torn down while its opening handshake is still in
 * flight: `WebSocketShard.destroy()` only awaits/cleans the socket when it is
 * already OPEN, otherwise it nulls `connection.onerror` immediately. The pending
 * `ws` request later hits its `handshakeTimeout`, emits `'error'` on a socket
 * with no listener, and Node escalates that to an `uncaughtException` that kills
 * the whole pi process — taking every other thread's session down with it.
 *
 * The shard reconnects on its own after this (and our own `onDisconnect`
 * reconnect is a second backstop), so the error is benign. We swallow only that
 * transient gateway class and re-raise anything else so genuine bugs still
 * crash fast.
 */

/** Transient socket error codes that are safe to swallow when they escape the gateway. */
const TRANSIENT_NET_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
]);

function errorCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

/** True when the error is a benign, self-healing Discord gateway socket failure. */
export function isTransientGatewayError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	// The exact ws handshake timeout that motivated this guard — no reliable
	// `code`, so match the message the ws library hardcodes.
	if (/handshake has timed out/i.test(error.message)) return true;
	// Otherwise only trust it if it both looks like a transient network fault
	// and demonstrably originates from the gateway socket stack.
	const code = errorCode(error);
	if (!code || !TRANSIENT_NET_CODES.has(code)) return false;
	const stack = error.stack ?? "";
	return /[/\\]ws[/\\]lib[/\\]/.test(stack) || /@discordjs[/\\]ws/.test(stack);
}

let installed = false;

/**
 * Installs the guard once per process. `log` receives a short line whenever a
 * transient gateway error is swallowed, so the hiccup is still observable.
 */
export function installGatewayCrashGuard(log: (message: string) => void): void {
	if (installed) return;
	installed = true;

	const onUncaughtException = (error: Error): void => {
		if (isTransientGatewayError(error)) {
			log(`Swallowed transient Discord gateway error: ${error.message} (shard will reconnect)`);
			return;
		}
		// Not ours: detach and re-throw so Node's default fatal behavior (or any
		// host-installed handler) still runs — we must not silence real crashes.
		process.off("uncaughtException", onUncaughtException);
		throw error;
	};

	const onUnhandledRejection = (reason: unknown): void => {
		if (isTransientGatewayError(reason)) {
			const message = reason instanceof Error ? reason.message : String(reason);
			log(`Swallowed transient Discord gateway rejection: ${message} (shard will reconnect)`);
			return;
		}
		process.off("unhandledRejection", onUnhandledRejection);
		throw reason;
	};

	process.on("uncaughtException", onUncaughtException);
	process.on("unhandledRejection", onUnhandledRejection);
}
