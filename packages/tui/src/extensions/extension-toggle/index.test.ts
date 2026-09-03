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
import type {
  ExtensionAPI,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { ExtensionToggles } from "../../../../core/src/shared/ExtensionToggles";
import { PimSettings } from "../../../../core/src/shared/PimSettings";
import registerExtensionToggle, { statusLines } from "./index";

type Notification = { readonly message: string; readonly level: string };

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
  registerExtensionToggle(api);
  return { command: command! };
}

function createCtx(selection?: string): {
  readonly ctx: never;
  readonly notifications: Notification[];
  readonly titles: string[];
  readonly options: string[][];
} {
  const notifications: Notification[] = [];
  const titles: string[] = [];
  const options: string[][] = [];
  const ctx = {
    ui: {
      notify(message: string, level: string): void {
        notifications.push({ message, level });
      },
      async select(title: string, opts: string[]): Promise<string | undefined> {
        titles.push(title);
        options.push(opts);
        return selection;
      },
    },
  } as never;
  return { ctx, notifications, titles, options };
}

beforeAll(async () => {
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
  await PimSettings.set("extensions", { disabled: [] });
});

describe("/extensions command", () => {
  test("toggles a named extension and says a restart is needed", async () => {
    const { command } = register();
    const { ctx, notifications } = createCtx();

    await command.handler("web-search", ctx);

    expect(notifications).toEqual([
      {
        message: "web-search disabled. Restart pim for this to take effect.",
        level: "info",
      },
    ]);
    await expect(ExtensionToggles.disabled()).resolves.toEqual(["web-search"]);

    await command.handler(" web-search ", ctx);
    await expect(ExtensionToggles.disabled()).resolves.toEqual([]);
  });

  test("reports an error for unknown or required names", async () => {
    const { command } = register();
    const { ctx, notifications } = createCtx();

    await command.handler("nope", ctx);
    await command.handler("_init", ctx);

    expect(notifications.map((n) => n.level)).toEqual(["error", "error"]);
    expect(notifications[0]!.message).toContain('Unknown pim extension "nope"');
    expect(notifications[1]!.message).toContain("cannot be disabled");
  });

  test("with no args, offers the roster and toggles the choice", async () => {
    const { command } = register();
    const { ctx, options, notifications } = createCtx("bash    enabled");

    await command.handler("", ctx);

    expect(options[0]!.length).toBe(ExtensionToggles.NAMES.length);
    expect(options[0]!.some((line) => line.includes("required"))).toBe(true);
    expect(notifications[0]!.message).toContain("bash disabled");
    await expect(ExtensionToggles.disabled()).resolves.toEqual(["bash"]);
  });

  test("refuses to toggle a required extension picked from the list", async () => {
    const { command } = register();
    const { ctx, notifications } = createCtx("_init              required");

    await command.handler("", ctx);

    expect(notifications).toEqual([
      {
        message: "_init is required by pim and cannot be disabled",
        level: "warning",
      },
    ]);
  });

  test("a cancelled selection changes nothing", async () => {
    const { command } = register();
    const { ctx, notifications } = createCtx(undefined);

    await command.handler("", ctx);

    expect(notifications).toEqual([]);
    await expect(ExtensionToggles.disabled()).resolves.toEqual([]);
  });

  test("status lines mark disabled entries", async () => {
    await ExtensionToggles.setDisabled("todo", true);

    const lines = await statusLines();

    expect(lines).toContain(`${"todo".padEnd(18)} disabled`);
    expect(lines).toContain(`${"bash".padEnd(18)} enabled`);
    expect(lines).toContain(`${"_init".padEnd(18)} required`);
  });

  test("argument completions exclude required extensions", async () => {
    const { command } = register();

    const items = await command.getArgumentCompletions!("");

    expect(items!.map((i) => i.value)).not.toContain("_init");
    expect(items!.map((i) => i.value)).toContain("web-fetch");
  });
});
