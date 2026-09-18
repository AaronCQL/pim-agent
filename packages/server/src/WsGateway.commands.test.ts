import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { until } from "#core/shared/fixtures/wait";
import {
  isDurableEvent,
  type ResponseEvent,
  type ServerEvent,
} from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const REPLY = "on it";

/**
 * A real extension, loaded off disk by pi's own resource loader: the dispatch
 * under test is `extensionRunner.getCommand`, which only a genuine
 * registration answers for. `probe-record` writes its answer down because
 * `notify` has nowhere to land once the last client has gone.
 */
function extensionSource(recordPath: string): string {
  return `
export default (pi) => {
  pi.registerCommand("probe-notice", {
    description: "says something back",
    handler: async (args, ctx) => {
      ctx.ui.notify(\`probe heard: \${args}\`, "info");
    },
  });
  pi.registerCommand("probe-ask", {
    description: "asks before it says anything",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("Drop the table?", "there is no undo");
      ctx.ui.notify(\`probe confirmed: \${ok}\`, "info");
    },
  });
  pi.registerCommand("probe-record", {
    description: "asks, and writes down whatever it is answered",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("Anyone there?", "answer within the grace");
      await Bun.write(${JSON.stringify(recordPath)}, String(ok));
    },
  });
};
`;
}

let tmp: string;
let agentDir: string;
let recordPath: string;
let previousAgentDir: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];
let gate: Promise<void> | undefined;
let openGate: (() => void) | undefined;

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

/** Holds the turn open until the test releases it; `afterEach` releases one a failure skipped. */
function holdTurn(): () => void {
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return releaseTurn;
}

function releaseTurn(): void {
  gate = undefined;
  openGate?.();
  openGate = undefined;
}

function startModelServer(): void {
  modelServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encode = (s: string) => controller.enqueue(Buffer.from(s));
          encode(chunk({ role: "assistant", content: "" }));
          encode(chunk({ content: REPLY }));
          await gate;
          encode(chunk({}, "stop"));
          encode("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
}

async function connect(sessionId?: string): Promise<ProbeClient> {
  const probe = new ProbeClient({
    url: gateway.url,
    cwd: tmp,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

function notices(
  probe: ProbeClient
): readonly Extract<ServerEvent, { type: "ui_notice" }>[] {
  return probe.events.filter((event) => event.type === "ui_notice");
}

/** The notice a command raised, waited for rather than slept on. */
async function noticed(probe: ProbeClient, from = 0): Promise<string> {
  const event = await probe.waitFor(
    (candidate) => candidate.type === "ui_notice",
    {
      from,
      timeoutMs: 20_000,
    }
  );
  return event.type === "ui_notice" ? event.text : "";
}

beforeEach(async () => {
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-commands-gateway-"));
  agentDir = join(tmp, "agent");
  recordPath = join(tmp, "probe-record.txt");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(
    join(agentDir, "extensions", "probe.ts"),
    extensionSource(recordPath)
  );
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        test: {
          baseUrl: `http://localhost:${modelServer?.port}/v1`,
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "echo", maxTokens: 1024, contextWindow: 8192 }],
        },
      },
    })
  );
  registry = new SessionRegistry({
    defaults: { cwd: tmp, model: "test/echo" },
    agentDir,
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
    sessionMetaPath: join(tmp, "sessions.json"),
    // The ceiling stays at its production three minutes, so only the grace can
    // settle a dialog inside a suite that runs in seconds.
    detachGraceMs: 0,
  });
  gateway.start();
});

afterEach(async () => {
  for (const probe of probes) {
    probe.close();
  }
  probes = [];
  releaseTurn();
  await gateway.stop();
  await registry.disposeAll();
  await modelServer?.stop(true);
  modelServer = undefined;
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("dispatches a registered command instead of prompting with it", async () => {
  const probe = await connect();
  const mark = probe.events.length;

  // Untrimmed, as a client that does not trim would send it: pi dispatches on
  // the text this server hands it, so the check has to read what pi will.
  const answer = await probe.prompt(" /probe-notice hello");

  expect(answer.success).toBe(true);
  expect(answer.dispatched).toBe(true);
  expect(await noticed(probe, mark)).toBe("probe heard: hello");
  // No user entry, no turn: the model was never called and nothing was written.
  expect(registry.peek(probe.sessionId!)?.status).toBe("idle");
  expect(probe.events.filter(isDurableEvent)).toEqual([]);
  // And nothing on disk either: a client arriving afterwards is replayed nothing.
  const later = await connect(probe.sessionId!);
  expect(later.events.filter(isDurableEvent)).toEqual([]);
});

test("says what a command notified to every client attached to the session", async () => {
  const first = await connect();
  const second = await connect(first.sessionId!);
  const marks = [first.events.length, second.events.length] as const;

  await first.prompt("/probe-notice both");

  expect(await noticed(first, marks[0])).toBe("probe heard: both");
  expect(await noticed(second, marks[1])).toBe("probe heard: both");
  // Named: the user typed it, so it belongs in that command's modal rather than a toast.
  expect(notices(second).at(-1)?.command).toBe("/probe-notice");
  expect(notices(second).at(-1)?.severity).toBe("info");
});

/**
 * §1b: merging a command into the steer queue made the joined string start
 * with the *earlier* message, so pi never saw the `/` and sent the command to
 * the model as English — and swallowed the queued message doing it.
 */
test("dispatches mid-turn without eating the message already queued", async () => {
  const release = holdTurn();
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("say hello");
  await until(
    () => registry.peek(probe.sessionId!)?.isStreaming === true,
    "the turn to start streaming"
  );
  await probe.prompt("and then this one");

  const answer = await probe.prompt("/probe-notice mid-turn");

  expect(answer.dispatched).toBe(true);
  expect(await noticed(probe, mark)).toBe("probe heard: mid-turn");
  const dequeued = await probe.send({
    type: "dequeue",
    sessionId: probe.sessionId!,
  });
  expect(dequeued.restored).toEqual(["and then this one"]);
  release();
});

test("sends an unregistered slash to the model verbatim", async () => {
  const probe = await connect();
  const mark = probe.events.length;

  const answer = await probe.prompt("/nope");

  expect(answer.success).toBe(true);
  expect(answer.dispatched).toBeUndefined();
  const said = await probe.waitFor(
    (event) => event.type === "message" && event.role === "user",
    { from: mark, timeoutMs: 20_000 }
  );
  expect(said.type === "message" && said.text).toBe("/nope");
});

/**
 * The picker offers extension commands only while an agent exists, so a
 * command typed at a session whose agent has been let go is someone working
 * from memory — and it still has to dispatch rather than reach the model.
 */
test("builds the agent for a command typed at a cold session", async () => {
  const probe = await connect();
  // Pi writes the session file at the first assistant message, and a host let
  // go before that reopens nothing: it starts a second session instead.
  await probe.prompt("say hello");
  const host = registry.peek(probe.sessionId!)!;
  await until(
    async () =>
      host.status === "idle" &&
      host.settings.sessionPath !== undefined &&
      (await Bun.file(host.settings.sessionPath).exists()),
    "the turn to land on disk"
  );
  await host.invalidate();
  expect(host.agentSession).toBeUndefined();
  const mark = probe.events.length;

  const answer = await probe.prompt("/probe-notice cold");

  expect(answer.dispatched).toBe(true);
  expect(await noticed(probe, mark)).toBe("probe heard: cold");
});

test("carries a dialog to the client and the answer back to the extension", async () => {
  const probe = await connect();
  const mark = probe.events.length;

  const answer = await probe.prompt("/probe-ask");
  expect(answer.dispatched).toBe(true);

  const asked = await probe.waitFor((event) => event.type === "ui_request", {
    from: mark,
    timeoutMs: 20_000,
  });
  expect(asked.type === "ui_request" && asked.method).toBe("confirm");
  expect(asked.type === "ui_request" && asked.title).toBe("Drop the table?");
  const requestId = asked.type === "ui_request" ? asked.requestId : "";

  const accepted = await probe.send({
    type: "ui_response",
    sessionId: probe.sessionId!,
    requestId,
    confirmed: true,
  });
  expect(accepted.success).toBe(true);
  await probe.waitFor(
    (event) =>
      event.type === "ui_request_done" && event.requestId === requestId,
    { from: mark, timeoutMs: 20_000 }
  );
  await until(
    () => notices(probe).some((notice) => notice.text.includes("confirmed")),
    "the extension to hear its answer"
  );
  expect(notices(probe).at(-1)?.text).toBe("probe confirmed: true");

  // The request is settled, so the same answer sent twice is refused rather
  // than applied to whatever asks next.
  const again = await probe.send({
    type: "ui_response",
    sessionId: probe.sessionId!,
    requestId,
    confirmed: true,
  });
  expect(again.success).toBe(false);
  expect(again.error).toContain(requestId);
});

test("refuses an answer to a request nobody is waiting on", async () => {
  const probe = await connect();

  const refused: ResponseEvent = await probe.send({
    type: "ui_response",
    sessionId: probe.sessionId!,
    requestId: "made-up",
    cancelled: true,
  });

  expect(refused.success).toBe(false);
  expect(refused.error).toContain("made-up");
});

/**
 * The gateway watches every stream it builds for `session_state`, and while it
 * did that as a subscriber the stream counted it as a reader: no session was
 * ever detached, so the grace never started and a dialog the last client
 * walked away from held its extension for the whole ceiling.
 */
test("answers a dialog the last client walked away from", async () => {
  const probe = await connect();
  const mark = probe.events.length;

  expect((await probe.prompt("/probe-record")).dispatched).toBe(true);
  await probe.waitFor((event) => event.type === "ui_request", {
    from: mark,
    timeoutMs: 20_000,
  });

  probe.close();

  await until(
    () => Bun.file(recordPath).exists(),
    "the extension to be answered for"
  );
  expect(await Bun.file(recordPath).text()).toBe("false");
});
