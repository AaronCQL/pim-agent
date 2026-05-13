import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Config, type TelegramConfig } from "./Config.ts";
import { SessionRegistry } from "./SessionRegistry.ts";

let tmp: string;
let config: TelegramConfig;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-session-registry-test-"));
  config = {
    token: "token",
    allow: [],
    cwd: tmp,
    configDir: tmp,
  };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("SessionRegistry state", () => {
  test("loads persisted state before command-first mutations", async () => {
    await Config.saveStateAtomic(tmp, {
      threads: {
        "1-main": {
          cwd: "/repo",
          cumulativeCost: 12.5,
          sessionPath: "/sessions/one.jsonl",
        },
      },
    });

    const registry = new SessionRegistry(config);
    await registry.init();
    await registry.setThreadThinkingLevel(
      { chatId: 2, threadId: undefined },
      "off"
    );

    const loaded = await Config.loadState(tmp);
    expect(loaded.threads["1-main"]).toEqual({
      cwd: "/repo",
      cumulativeCost: 12.5,
      sessionPath: "/sessions/one.jsonl",
    });
    expect(loaded.threads["2-main"]?.thinkingLevel).toBe("off");
  });

  test("does not flush empty state when disposed before init", async () => {
    await Config.saveStateAtomic(tmp, {
      threads: {
        "1-main": {
          cwd: "/repo",
          cumulativeCost: 12.5,
        },
      },
    });

    const registry = new SessionRegistry(config);
    await registry.disposeAll();

    const loaded = await Config.loadState(tmp);
    expect(loaded.threads["1-main"]).toEqual({
      cwd: "/repo",
      cumulativeCost: 12.5,
    });
  });
});
