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
    // Trailing newline to separate from other widgets right below; newline will
    // not show up when this widget is the only one shown
    const message = `⣿ Clanked for ${Format.formatElapsed(Date.now() - startedAt)}\n`;
    ctx.ui.setWidget(FINAL_WIDGET_ID, [ctx.ui.theme.fg("muted", message)]);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setWidget(FINAL_WIDGET_ID, undefined);
  });
}
