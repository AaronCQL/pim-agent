import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { PimVersion } from "#core/shared/PimVersion";

const SPLASH_ID = "pim-splash";
const UPDATE_CHECK_TIMEOUT_MS = 3_000;

const shortcuts = [
  ["Ctrl+C", "Clear editor (first) / exit (second)"],
  ["Escape", "Cancel autocomplete / abort streaming"],
  ["/<command>", "Slash commands", "<command>"],
  ["/hotkeys", "Show all keyboard shortcuts"],
  ["/settings", "Open settings menu"],
  ["/pim", "Enable or disable pim extensions"],
  ["@<path>", "Attach files", "<path>"],
  ["!<command>", "Run bash command", "<command>"],
  ["!!<command>", "Run bash command (excluded from context)", "<command>"],
] as const;

export default async function (pi: ExtensionAPI): Promise<void> {
  if (typeof Bun === "undefined") {
    throw new Error(
      "Pim requires the Bun runtime.\n" +
        "To run Pim: bun install -g pim-agent, then run `pim`.\n" +
        "To run vanilla Pi without Pim: `pi -ne`."
    );
  }

  const version = await PimVersion.current();

  const keyCol = Math.max(...shortcuts.map(([k]) => k.length)) + 2;

  let splashShown = false;
  let update: string | undefined;
  let updateCheck: Promise<string | undefined> | undefined;

  // Pi's own update banner is suppressed: it names a `pi update` that cannot
  // reach the copy pim bundles. One line on the splash replaces it.
  const checkForUpdate = (): Promise<string | undefined> => {
    updateCheck ??= process.env["PI_OFFLINE"]
      ? Promise.resolve(undefined)
      : PimVersion.latest({ timeoutMs: UPDATE_CHECK_TIMEOUT_MS }).then(
          (available) =>
            available !== undefined && PimVersion.isNewer(available, version)
              ? available
              : undefined
        );
    return updateCheck;
  };

  const showSplash = (ctx: ExtensionContext): void => {
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
      theme.bold(theme.fg("accent", "PIM - Pi IMproved")) +
      " " +
      theme.italic(theme.fg("muted", `v${version}`));
    ctx.ui.setWidget(SPLASH_ID, [
      title,
      ...shortcuts.map(
        ([k, d, muted]) => renderKey(k, muted) + theme.fg("dim", d)
      ),
      ...(update === undefined
        ? []
        : [
            "",
            theme.fg("warning", `Update available: v${update}`) +
              theme.fg("dim", " - run ") +
              theme.fg("mdCode", "pim update"),
          ]),
    ]);
    splashShown = true;
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") {
      return;
    }

    showSplash(ctx);
    void checkForUpdate().then((available) => {
      if (available === undefined || !splashShown) {
        return;
      }
      update = available;
      showSplash(ctx);
    });
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
