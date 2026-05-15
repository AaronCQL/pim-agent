import type { Api } from "grammy";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Fs } from "../shared/Fs";
import { type TelegramConfig } from "./Config";
import { SessionRegistry } from "./SessionRegistry";
import type { SessionSettings } from "./Session";
import { TaskScheduler } from "./TaskScheduler";

let tmp: string;
let config: TelegramConfig;
const stubApi = {} as Api;
const stubScheduler = new TaskScheduler({
  configDir: "/tmp",
  runTask: async () => {},
});

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

async function readState(): Promise<Record<string, SessionSettings>> {
  return Fs.readJsonOrEmpty<Record<string, SessionSettings>>(
    join(tmp, "state.json"),
    {}
  );
}

async function writeState(
  state: Record<string, SessionSettings>
): Promise<void> {
  await Fs.writeAtomic(join(tmp, "state.json"), JSON.stringify(state, null, 2));
}

describe("SessionRegistry state", () => {
  test("loads persisted state and preserves it when mutating another session", async () => {
    await writeState({
      "1-main": {
        cwd: "/repo",
        cumulativeCost: 12.5,
        sessionPath: "/sessions/one.jsonl",
      },
    });

    const registry = new SessionRegistry(config, stubApi, stubScheduler);
    await registry.init();
    const session = registry.get({ chatId: 2, threadId: undefined });
    await session.setThinkingLevel("off");

    const loaded = await readState();
    expect(loaded["1-main"]).toEqual({
      cwd: "/repo",
      cumulativeCost: 12.5,
      sessionPath: "/sessions/one.jsonl",
    });
    expect(loaded["2-main"]?.thinkingLevel).toBe("off");
  });

  test("does not flush state when disposed before init", async () => {
    await writeState({
      "1-main": {
        cwd: "/repo",
        cumulativeCost: 12.5,
      },
    });

    const registry = new SessionRegistry(config, stubApi, stubScheduler);
    await registry.disposeAll();

    const loaded = await readState();
    expect(loaded["1-main"]).toEqual({
      cwd: "/repo",
      cumulativeCost: 12.5,
    });
  });
});
