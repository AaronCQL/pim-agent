import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SPLASH_ID = "pim-splash";

const shortcuts = [
  ["Ctrl+C", "Clear editor (first) / exit (second)"],
  ["Escape", "Cancel autocomplete / abort streaming"],
  ["/<command>", "Slash commands", "<command>"],
  ["/hotkeys", "Show all keyboard shortcuts"],
  ["/settings", "Open settings menu"],
  ["@<path>", "Attach files", "<path>"],
  ["!<command>", "Run bash command", "<command>"],
  ["!!<command>", "Run bash command (excluded from context)", "<command>"],
] as const;

export default async function (pi: ExtensionAPI): Promise<void> {
  if (typeof Bun === "undefined") {
    throw new Error(
      "Pim requires the Bun runtime.\n" +
        "Install pi via bun: bun install -g @earendil-works/pi-coding-agent\n" +
        "Then run: pim"
    );
  }

  const pkgPath = `${import.meta.dir}/../../../package.json`;
  const { version } = (await Bun.file(pkgPath).json()) as { version: string };

  const keyCol = Math.max(...shortcuts.map(([k]) => k.length)) + 2;

  let splashShown = false;

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") {
      return;
    }

    const theme = ctx.ui.theme;
    const renderKey = (key: string, muted: string | undefined): string => {
      const padding = " ".repeat(Math.max(0, keyCol - key.length));
      if (!muted) {
        return theme.fg("mdCode", key + padding);
      }
      const idx = key.indexOf(muted);
      if (idx === -1) {
        return theme.fg("mdCode", key + padding);
      }
      return (
        theme.fg("mdCode", key.slice(0, idx)) +
        theme.fg("muted", muted) +
        key.slice(idx + muted.length) +
        padding
      );
    };

    const title =
      theme.bold(theme.fg("mdHeading", "PIM - Pi IMproved")) +
      " " +
      theme.italic(theme.fg("muted", `v${version}`));
    ctx.ui.setWidget(SPLASH_ID, [
      title,
      ...shortcuts.map(
        ([k, d, muted]) => renderKey(k, muted) + theme.fg("dim", d)
      ),
    ]);
    splashShown = true;
  });

  const clearSplash = (ctx: ExtensionContext) => {
    if (splashShown) {
      ctx.ui.setWidget(SPLASH_ID, undefined);
      splashShown = false;
    }
  };

  pi.on("input", (_event, ctx) => {
    clearSplash(ctx);
    return { action: "continue" };
  });
  pi.on("user_bash", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("session_before_fork", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("session_before_tree", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    clearSplash(ctx);
  });

  pi.registerCommand("clear", {
    description: "Start a new session (alias: /new)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession();
    },
  });
}
