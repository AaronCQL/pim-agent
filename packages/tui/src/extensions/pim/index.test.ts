import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  initTheme,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { ExtensionToggles } from "#core/shared/ExtensionToggles";
import { PimSettings } from "#core/shared/PimSettings";
import registerPim, { menuItems } from "./index";

type Notification = { readonly message: string; readonly level: string };

const DOWN = "\x1b[B";
const SPACE = " ";
const ESC = "\x1b";

let previousPimHomeDir: string | undefined;
let homeDir: string;

function register(): {
  readonly command: Omit<RegisteredCommand, "name" | "sourceInfo">;
} {
  let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  const api = {
    on(): void {},
    registerCommand(
      _name: string,
      options: Omit<RegisteredCommand, "name" | "sourceInfo">
    ): void {
      command = options;
    },
  } as unknown as ExtensionAPI;
  registerPim(api);
  return { command: command! };
}

/** Drives the real `SettingsList` the command hands to `ctx.ui.custom`. */
function createCtx(
  keys: readonly string[],
  mode = "tui"
): {
  readonly ctx: never;
  readonly notifications: Notification[];
  readonly reloads: () => number;
  readonly rendered: () => string[];
} {
  const notifications: Notification[] = [];
  let reloads = 0;
  let lines: string[] = [];
  const ctx = {
    mode,
    async reload(): Promise<void> {
      reloads += 1;
    },
    ui: {
      notify(message: string, level: string): void {
        notifications.push({ message, level });
      },
      async custom(
        factory: (
          tui: never,
          theme: never,
          keybindings: never,
          done: (result: void) => void
        ) => Component
      ): Promise<void> {
        await new Promise<void>((resolve) => {
          const component = factory(
            undefined as never,
            undefined as never,
            undefined as never,
            resolve
          );
          for (const key of keys) {
            component.handleInput?.(key);
          }
          lines = component.render(80);
        });
      },
    },
  } as never;
  return {
    ctx,
    notifications,
    reloads: () => reloads,
    rendered: () => lines,
  };
}

beforeAll(async () => {
  initTheme("dark", false);
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  homeDir = await mkdtemp(join(tmpdir(), "pim-toggle-cmd-"));
  process.env.PIM_HOME_DIR = homeDir;
});

afterAll(async () => {
  if (previousPimHomeDir === undefined) {
    delete process.env.PIM_HOME_DIR;
  } else {
    process.env.PIM_HOME_DIR = previousPimHomeDir;
  }
  await rm(homeDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await PimSettings.set("extensions", { toggles: {} });
});

describe("menuItems", () => {
  test("carries every extension with its state and description", async () => {
    await ExtensionToggles.setDisabled("todo", true);

    const items = await menuItems();

    expect(items.length).toBe(
      ExtensionToggles.NAMES.length - ExtensionToggles.REQUIRED.length
    );
    expect(items.find((i) => i.id === "todo")).toEqual({
      id: "todo",
      label: "todo",
      description: "todo tool",
      currentValue: "disabled",
      values: ["enabled", "disabled"],
    });
    expect(items.find((i) => i.id === "tps")?.currentValue).toBe("disabled");
    expect(items.find((i) => i.id === "bash")?.currentValue).toBe("enabled");
  });

  test("leaves required extensions out of the list", async () => {
    const items = await menuItems();

    for (const name of ExtensionToggles.REQUIRED) {
      expect(items.find((i) => i.id === name)).toBeUndefined();
    }
    expect(items.every((i) => i.values !== undefined)).toBe(true);
  });
});

describe("/pim command", () => {
  test("Space toggles the highlighted entry and Esc closes with one reload", async () => {
    const { command } = register();
    const { ctx, reloads } = createCtx([SPACE, ESC]);

    await command.handler("", ctx);

    await expect(ExtensionToggles.isDisabled("apply-patch")).resolves.toBe(
      true
    );
    expect(reloads()).toBe(1);
  });

  test("toggles several entries in one visit", async () => {
    const { command } = register();
    const { ctx, reloads } = createCtx([SPACE, DOWN, SPACE, ESC]);

    await command.handler("", ctx);

    await expect(ExtensionToggles.disabled()).resolves.toEqual([
      "apply-patch",
      "bash",
      "tps",
    ]);
    expect(reloads()).toBe(1);
  });

  test("an untouched menu skips the reload", async () => {
    const { command } = register();
    const { ctx, reloads } = createCtx([DOWN, DOWN, ESC]);

    await command.handler("", ctx);

    expect(reloads()).toBe(0);
  });

  test("shows pi's settings hint line", async () => {
    const { command } = register();
    const { ctx, rendered } = createCtx([ESC]);

    await command.handler("", ctx);

    const text = rendered().join("\n");
    expect(text).toContain("Enter/Space to change · Esc to cancel");
    expect(text).toContain("apply_patch tool");
    expect(text).not.toContain("_init");
    expect(text).toContain(
      `(1/${ExtensionToggles.NAMES.length - ExtensionToggles.REQUIRED.length})`
    );
  });

  test("refuses to open outside the TUI", async () => {
    const { command } = register();
    const { ctx, notifications, reloads } = createCtx([], "print");

    await command.handler("", ctx);

    expect(notifications).toEqual([
      { message: "/pim needs the interactive TUI", level: "warning" },
    ]);
    expect(reloads()).toBe(0);
  });
});
