import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

export async function runWithLoader<T>(
	ctx: ExtensionContext,
	message: string,
	work: () => Promise<T>,
): Promise<{ value?: T; error?: string }> {
	return ctx.ui.custom<{ value?: T; error?: string }>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
		void (async () => {
			try {
				done({ value: await work() });
			} catch (error) {
				done({ error: error instanceof Error ? error.message : String(error) });
			}
		})();
		return loader;
	});
}
