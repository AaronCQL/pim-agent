import type { Api } from "grammy";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import {
  assistant,
  HeldSession,
  parent,
  usage,
} from "#core/extensions/subagent/fixtures/session";
import { startSubagent } from "#core/extensions/subagent/subagent";
import { SubagentJobs } from "#core/extensions/subagent/SubagentJobs";
import {
  SubagentResult,
  type SubagentResultDetails,
} from "#core/extensions/subagent/SubagentResult";
import { AgentRuntime } from "#core/session/AgentRuntime";
import { EventLog } from "#core/session/EventLog";
import { until } from "#core/shared/fixtures/wait";
import type { TelegramConfig } from "./Config";
import { Session } from "./Session";
import { TaskScheduler } from "./TaskScheduler";
import { Turn } from "./Turn";

const quietLog = spyOn(console, "log").mockImplementation(() => {});

afterAll(() => {
  quietLog.mockRestore();
});

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

async function buildSession(
  options: {
    readonly api?: Api;
    readonly jobs?: SubagentJobs;
    readonly grace?: () => Promise<void>;
  } = {}
): Promise<Session> {
  const runtime = new AgentRuntime(agentDir);
  await runtime.init();
  return new Session({
    id: { chatId: 1, threadId: undefined },
    settings: {},
    config,
    api: options.api ?? stubApi,
    runtime,
    scheduler: new TaskScheduler({ configDir: tmp, runTask: async () => {} }),
    persistSettings: async () => {},
    getBotUsername: () => undefined,
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    ...(options.grace === undefined ? {} : { grace: options.grace }),
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

describe("background jobs", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let prompts: string[] = [];
  /** Stalls every reply until released. */
  let gate: PromiseWithResolvers<void> | undefined;
  let jobs: SubagentJobs;
  let session: Session | undefined;

  function sse(delta: Record<string, unknown>, finish?: string): string {
    return `data: ${JSON.stringify({
      id: "1",
      object: "chat.completion.chunk",
      created: 0,
      model: "echo",
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })}\n\n`;
  }

  beforeEach(async () => {
    prompts = [];
    gate = undefined;
    jobs = new SubagentJobs();
    server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const body = (await req.json()) as {
          readonly messages: readonly { readonly content: unknown }[];
        };
        prompts.push(JSON.stringify(body.messages.at(-1)?.content));
        const held = gate?.promise;
        const reply = `reply ${prompts.length}`;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (text: string) =>
              controller.enqueue(Buffer.from(text));
            send(sse({ role: "assistant", content: reply }));
            await held;
            send(sse({}, "stop"));
            send("data: [DONE]\n\n");
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    await Bun.write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            baseUrl: `http://localhost:${server.port}/v1`,
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: "echo", maxTokens: 1024, contextWindow: 8192 }],
          },
        },
      })
    );
    config = { ...config, model: "test/echo" };
  });

  afterEach(async () => {
    gate?.resolve();
    await jobs.stopEverything();
    await session?.run(async () => {});
    await session?.dispose();
    session = undefined;
    await server?.stop(true);
    server = undefined;
  });

  class ChatApi {
    public readonly sent: string[] = [];
    public readonly edited: string[] = [];
    public hold: Promise<void> | undefined;

    public async sendRichMessage(
      _chatId: number,
      rich: { readonly html: string }
    ): Promise<{ readonly message_id: number }> {
      this.sent.push(rich.html);
      return { message_id: this.sent.length };
    }

    public async editMessageText(
      _chatId: number,
      _messageId: number,
      rich: { readonly html: string }
    ): Promise<void> {
      await this.hold;
      this.edited.push(rich.html);
    }

    public async sendChatAction(): Promise<void> {}
  }

  async function results(): Promise<readonly SubagentResultDetails[]> {
    const entries = await new EventLog(
      join(tmp, "sessions", "1-main.jsonl")
    ).read();
    return entries.flatMap(({ entry }) =>
      entry.type === "custom_message" &&
      entry.customType === SubagentResult.CUSTOM_TYPE
        ? [entry.details as SubagentResultDetails]
        : []
    );
  }

  async function chatSession(grace?: () => Promise<void>) {
    const api = new ChatApi();
    session = await buildSession({
      api: api as unknown as Api,
      jobs,
      ...(grace === undefined ? {} : { grace }),
    });
    const built = session;
    const turn = (text: string) =>
      built.run((agent) =>
        Turn.run(built, api as unknown as Api, agent, (a) => a.prompt(text))
      );
    let sessionId = "";
    await turn("hello");
    await built.run(async (agent) => {
      sessionId = agent.sessionId;
    });
    const spawn = async (
      callId: string,
      contextWindow?: number
    ): Promise<HeldSession> => {
      const child = new HeldSession();
      jobs.spawn(sessionId, {
        callId,
        prompt: `task ${callId}`,
        lastHandle: 0,
        start: (onChange) =>
          startSubagent(
            `task ${callId}`,
            contextWindow === undefined
              ? parent
              : { ...parent, model: { contextWindow } as never },
            {
              createSession: async () => child,
              onChange,
            }
          ),
      });
      await until(() => child.promptCalls === 1, "the child prompt");
      return child;
    };
    return { api, session: built, sessionId, turn, spawn };
  }

  test("a finished job wakes the chat with a rendered turn", async () => {
    const { api, session, spawn } = await chatSession();
    const child = await spawn("call-1");
    await until(() => api.sent.length === 2, "the jobs message");
    expect(api.sent[1]).toStartWith("🤖 <b>1 job running</b><br>• <b>j1</b>: ");
    expect(session.pinned).toBe(true);

    child.finish("found three bugs");
    await until(() => api.sent.includes("<p>reply 2</p>"), "the woken reply");

    expect(prompts[1]).toContain("found three bugs");
    expect(api.sent.slice(2)).toEqual([
      "🤖 j1 ⬝ 1 turn ⬝ $0.00",
      "<p>reply 2</p>",
    ]);
    await until(
      () => api.edited.includes("🤖 1 job ended"),
      "the jobs message to close"
    );
    expect(session.pinned).toBe(false);
  });

  test("a job's context notice wakes the chat while the job runs on", async () => {
    const { api, session, sessionId, spawn } = await chatSession();
    const child = await spawn("call-1", 10_000);
    await until(() => api.sent.length === 2, "the jobs message");

    child.emit({
      type: "message_end",
      message: assistant(["Working."], {
        stopReason: "toolUse",
        usage: usage({ totalTokens: 4_500 }),
      }),
    });
    await until(() => api.sent.includes("<p>reply 2</p>"), "the woken reply");

    expect(prompts[1]).toContain(
      "[subagent job j1 at 45% context, still running]"
    );
    expect(jobs.hasRunning(sessionId)).toBe(true);
    expect(await results()).toEqual([]);
    expect(session.pinned).toBe(true);
  });

  test("a job that finishes mid-turn shows its result in that turn", async () => {
    const { api, session, sessionId, turn, spawn } = await chatSession();
    const child = await spawn("call-1");
    gate = Promise.withResolvers<void>();
    const running = turn("keep going");
    await until(
      () => session.isStreaming && prompts.length === 2,
      "the turn to stream"
    );

    child.finish("found three bugs");
    await until(() => !jobs.hasRunning(sessionId), "the job to finish");
    gate.resolve();
    await running;

    expect(prompts[2]).toContain("found three bugs");
    expect(api.sent.slice(2)).toEqual([
      "🤖 j1 ⬝ 1 turn ⬝ $0.00",
      "<p>reply 3</p>",
    ]);
  });

  test("dispose waits for the jobs message's closing edit", async () => {
    const edit = Promise.withResolvers<void>();
    const {
      api,
      session: built,
      spawn,
    } = await chatSession(() => {
      edit.resolve();
      return new Promise<void>(() => {});
    });
    await spawn("call-1");
    await until(() => api.sent.length === 2, "the jobs message");
    api.hold = edit.promise;
    await built.cancel();

    await built.dispose();
    session = undefined;

    expect(api.edited.at(-1)).toBe("🤖 1 job ended");
  });

  test("a message sent during a woken turn runs after it, in order", async () => {
    const { api, session, turn, spawn } = await chatSession();
    const child = await spawn("call-1");
    gate = Promise.withResolvers<void>();

    child.finish("the answer");
    await until(
      () => session.isStreaming && prompts.length === 2,
      "the woken turn to stream"
    );
    const next = turn("what now?");
    expect(prompts).toHaveLength(2);
    gate.resolve();
    await next;

    expect(prompts[2]).toContain("what now?");
    expect(api.sent.filter((text) => text.startsWith("<p>"))).toEqual([
      "<p>reply 1</p>",
      "<p>reply 2</p>",
      "<p>reply 3</p>",
    ]);
  });

  test("cancel while idle stops the jobs without a turn", async () => {
    const { api, session, spawn } = await chatSession();
    await spawn("call-1");
    await spawn("call-2");

    expect(await session.cancel()).toMatchObject({
      aborted: false,
      stopped: 2,
    });
    await until(
      () => api.edited.includes("🤖 2 jobs ended"),
      "the jobs message to close"
    );
    await until(
      async () => (await results()).length === 2,
      "the stopped results"
    );

    expect(await results()).toMatchObject([
      { state: "stopped", stoppedBy: "user" },
      { state: "stopped", stoppedBy: "user" },
    ]);
    expect(prompts).toHaveLength(1);
    await until(() => !session.pinned, "the results to land");
    expect((await session.cancel()).cancelled).toBe(false);
  });

  test("cancel while a finished job waits to wake the chat lands its result without a turn", async () => {
    const { api, session, sessionId, spawn } = await chatSession();
    const finished = await spawn("call-1");
    await spawn("call-2");
    const queue = Promise.withResolvers<void>();
    const busy = session.run(() => queue.promise);

    finished.finish("found three bugs");
    await until(
      () => jobs.list(sessionId).length === 1,
      "the first job to finish"
    );
    const cancelling = session.cancel();
    queue.resolve();
    await busy;

    expect(await cancelling).toMatchObject({ aborted: false, stopped: 1 });
    await until(() => !session.pinned, "the results to land");
    expect(await results()).toMatchObject([
      { jobId: "call-1", state: "done" },
      { jobId: "call-2", state: "stopped", stoppedBy: "user" },
    ]);
    expect(prompts).toHaveLength(1);
    expect(api.sent.filter((html) => html.includes(" done "))).toEqual([]);
  });
});
