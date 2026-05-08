import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SPLASH_ID = "pim-splash";

const shortcuts = [
  ["Ctrl+C / Ctrl+D", "quit"],
  ["Esc", "stop the current agent"],
  ["/", "run a command"],
  ["@", "attach files"],
  ["!", "run bash"],
  ["!!", "run bash (no context)"],
] as const;

export default async function (pi: ExtensionAPI): Promise<void> {
  if (typeof Bun === "undefined") {
    throw new Error(
      "Pim requires the Bun runtime.\n" +
        "Install pi via: bun install -g @mariozechner/pi-coding-agent\n" +
        "Then run: bunx pi\n" +
        "Node-installed pi is not supported."
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
    ctx.ui.setWidget(SPLASH_ID, [
      theme.fg("accent", `PIM - Pi IMproved v${version}`),
      "",
      ...shortcuts.map(([k, d]) => k.padEnd(keyCol) + theme.fg("dim", d)),
    ]);
    splashShown = true;
  });

  pi.on("input", (_event, ctx) => {
    if (splashShown) {
      ctx.ui.setWidget(SPLASH_ID, undefined);
      splashShown = false;
    }
    return { action: "continue" };
  });
}
