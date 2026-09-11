import {
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import type { TelegramConfig } from "./Config";
import { Session } from "./Session";
import { TaskScheduler } from "./TaskScheduler";

let tmp: string;
let agentDir: string;
let config: TelegramConfig;

const stubApi = {} as Api;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-session-test-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
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

async function buildSession(): Promise<Session> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  return new Session({
    id: { chatId: 1, threadId: undefined },
    settings: {},
    config,
    api: stubApi,
    agentDir,
    modelRuntime,
    modelRegistry: new ModelRegistry(modelRuntime),
    scheduler: new TaskScheduler({ configDir: tmp, runTask: async () => {} }),
    settingsManagerFor: (cwd) => SettingsManager.create(cwd, agentDir),
    persistSettings: async () => {},
    getBotUsername: () => undefined,
  });
}

async function writeLifecycleExtension(log: string): Promise<void> {
  await Bun.write(
    join(agentDir, "extensions", "lifecycle.ts"),
    `export default function (pi: any) {
       const append = async (line: string) => {
         const file = Bun.file(${JSON.stringify(log)});
         const prev = (await file.exists()) ? await file.text() : "";
         await Bun.write(${JSON.stringify(log)}, prev + line + "\\n");
       };
       pi.on("session_start", () => append("start"));
       pi.on("session_shutdown", () => append("shutdown"));
     }\n`
  );
}

async function readLog(log: string): Promise<readonly string[]> {
  const file = Bun.file(log);
  if (!(await file.exists())) {
    return [];
  }
  return (await file.text()).trim().split("\n");
}

test("emits session_start and session_shutdown to extensions", async () => {
  const log = join(tmp, "lifecycle.log");
  await writeLifecycleExtension(log);

  const session = await buildSession();
  await session.run(async () => {});
  expect(await readLog(log)).toEqual(["start"]);

  await session.dispose();
  expect(await readLog(log)).toEqual(["start", "shutdown"]);
});

test("emits session_start and session_shutdown for isolated runs", async () => {
  const log = join(tmp, "lifecycle.log");
  await writeLifecycleExtension(log);

  const session = await buildSession();
  await session.run(async () => {}, { isolated: true });

  expect(await readLog(log)).toEqual(["start", "shutdown"]);
});

test("exposes pi's session uuid once an agent exists", async () => {
  const session = await buildSession();
  expect(session.sessionId).toBeUndefined();

  let uuid: string | undefined;
  await session.run(async (agent) => {
    uuid = agent.sessionId;
  });
  expect(session.sessionId).toBe(uuid);
});

test("re-emits session_start when the agent reloads mid-session", async () => {
  const log = join(tmp, "lifecycle.log");
  await writeLifecycleExtension(log);
  await mkdir(join(tmp, "instructions"), { recursive: true });

  const session = await buildSession();
  await session.run(async () => {});
  await Bun.write(join(tmp, "instructions", "1-main.md"), "be brief");
  await session.run(async () => {});

  expect(await readLog(log)).toEqual(["start", "shutdown", "start"]);
});
