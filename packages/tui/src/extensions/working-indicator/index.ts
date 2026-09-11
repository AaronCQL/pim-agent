import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { Format } from "#core/shared/Format";

const FINAL_WIDGET_ID = "pim-working-finished";

export default function (pi: ExtensionAPI): void {
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const clear = (ctx: ExtensionContext): void => {
    stopTimer();
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setWidget(FINAL_WIDGET_ID, undefined);
  };

  const setWorkingMessage = (ctx: ExtensionContext): void => {
    ctx.ui.setWorkingMessage(
      `Clanking… ${Format.formatElapsed(Date.now() - startedAt)}`
    );
  };

  const setWorkingIndicator = (ctx: ExtensionContext): void => {
    ctx.ui.setWorkingIndicator({
      frames: ["⣼", "⣹", "⢻", "⠿", "⡟", "⣏", "⣧", "⣶"].map((frame) =>
        ctx.ui.theme.fg("accent", frame)
      ),
      intervalMs: 80,
    });
  };

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }

    startedAt = Date.now();
    ctx.ui.setWidget(FINAL_WIDGET_ID, undefined);
    setWorkingIndicator(ctx);
    setWorkingMessage(ctx);
    stopTimer();
    timer = setInterval(() => setWorkingMessage(ctx), 1000);
  });

  pi.on("agent_end", (_event, ctx) => {
    stopTimer();
    if (!ctx.hasUI) {
      return;
    }
    const message = `⣿ Clanked for ${Format.formatElapsed(Date.now() - startedAt)}\n`;
    ctx.ui.setWidget(FINAL_WIDGET_ID, [ctx.ui.theme.fg("muted", message)]);
  });

  // Not redundant with `session_shutdown`: that is process exit, and a new chat or `/resume`
  // swaps the conversation under the widget without it.
  pi.on("session_before_switch", (_event, ctx) => {
    clear(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clear(ctx);
  });
}
