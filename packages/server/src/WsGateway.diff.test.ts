import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import { Proc } from "#core/shared/Proc";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

/**
 * The change set of a session's repository, over the wire: what the diff
 * overlay lists, what it gets when it expands a row, and what it commits.
 */

let tmp: string;
let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];
let modelServer: ReturnType<typeof Bun.serve> | undefined;
/** Set by a test to hold the one turn this file ever runs open until it says otherwise. */
let gate: Promise<void> | undefined;

function holdTurn(): () => void {
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    gate = undefined;
    release();
  };
}

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

/** Answers one word and then waits on `gate`, so a test can sit inside a running turn. */
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
          const encode = (text: string) =>
            controller.enqueue(Buffer.from(text));
          encode(chunk({ role: "assistant", content: "working" }));
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

/** Polls, because a turn ends well after the event that announced its last word. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

async function shaOf(): Promise<string> {
  const { stdout } = await Proc.run(["git", "rev-parse", "--short", "HEAD"], {
    cwd,
  });
  return stdout.trim();
}

async function statusOf(): Promise<string> {
  const { stdout } = await Proc.run(["git", "status", "--porcelain"], { cwd });
  return stdout.trim();
}

async function connect(): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

function sessionOf(probe: ProbeClient): string {
  const sessionId = probe.sessionId;
  if (sessionId === undefined) {
    throw new Error("the probe never attached");
  }
  return sessionId;
}

beforeEach(async () => {
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-diff-gateway-"));
  cwd = join(tmp, "work");
  agentDir = join(tmp, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
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

  await makeRepo(cwd);
  await git(cwd, ["config", "user.email", "pim@example.com"]);
  await git(cwd, ["config", "user.name", "pim"]);
  await Bun.write(join(cwd, "sp ace.txt"), "one\ntwo\n");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", "tracked"]);
  await Bun.write(join(cwd, "sp ace.txt"), "one\ntwo\nthree\n");
  await Bun.write(join(cwd, "loose.txt"), "fresh\n");

  registry = new SessionRegistry({
    defaults: { cwd, model: "test/echo" },
    agentDir,
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
  });
  gateway.start();
});

afterEach(async () => {
  for (const probe of probes) {
    probe.close();
  }
  probes = [];
  gate = undefined;
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

test("list_changes answers the session's change set, untracked included", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "list_changes",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
  });

  expect(response.success).toBe(true);
  expect(response.changes?.files.map((file) => file.path)).toEqual([
    "sp ace.txt",
    "loose.txt",
  ]);
  expect(response.changes).toMatchObject({
    base: { kind: "worktree" },
    added: 2,
    removed: 0,
  });
});

test("list_changes narrows to the base it is given", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "list_changes",
    sessionId: sessionOf(probe),
    base: { kind: "staged" },
  });

  expect(response.success).toBe(true);
  expect(response.changes?.files).toEqual([]);
});

test("file_diff answers hunks for one path, and only when asked", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "file_diff",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
    path: "sp ace.txt",
  });

  expect(response.success).toBe(true);
  expect(response.fileDiff?.path).toBe("sp ace.txt");
  expect(
    response.fileDiff?.hunks[0]?.lines.map((line) => [line.kind, line.text])
  ).toEqual([
    ["context", "one"],
    ["context", "two"],
    ["added", "three"],
  ]);
});

test("file_diff takes the context it is sent", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "file_diff",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
    path: "sp ace.txt",
    context: 0,
  });

  expect(response.fileDiff?.hunks[0]?.lines).toEqual([
    { kind: "added", newLine: 3, text: "three" },
  ]);
});

test("read_lines answers the file's own lines behind a gap", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "read_lines",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
    path: "sp ace.txt",
    spans: [{ start: 2, end: 3 }],
  });

  expect(response.success).toBe(true);
  expect(response.fileLines).toEqual({
    path: "sp ace.txt",
    runs: [{ start: 2, lines: ["two", "three"] }],
  });
});

test("an untracked file diffs against nothing", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "file_diff",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
    path: "loose.txt",
  });

  expect(response.fileDiff?.hunks[0]?.lines).toEqual([
    { kind: "added", newLine: 1, text: "fresh" },
  ]);
});

test("a base git cannot resolve comes back as an error, not an empty list", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "list_changes",
    sessionId: sessionOf(probe),
    base: { kind: "commit", ref: "no-such-ref" },
  });

  expect(response.success).toBe(false);
  expect(response.error).toContain("no-such-ref");
});

test("commit lands exactly the paths it is sent and answers their sha", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "commit",
    sessionId: sessionOf(probe),
    message: "the reviewed change",
    paths: ["sp ace.txt"],
  });

  expect(response.success).toBe(true);
  expect(response.commit?.sha).toBe(await shaOf());
  expect(await statusOf()).toBe("?? loose.txt");
});

test("commit refuses a message that is only whitespace", async () => {
  const probe = await connect();
  const before = await shaOf();

  const response = await probe.send({
    type: "commit",
    sessionId: sessionOf(probe),
    message: "   ",
    paths: ["sp ace.txt"],
  });

  expect(response.success).toBe(false);
  expect(response.error).toContain("message");
  expect(await shaOf()).toBe(before);
});

test("a commit is refused while the session's agent is mid-turn", async () => {
  const probe = await connect();
  const sessionId = sessionOf(probe);
  const mark = probe.events.length;
  const release = holdTurn();
  const before = await shaOf();
  try {
    await probe.prompt("edit something");
    await probe.waitFor(
      (event) => event.type === "session_state" && event.repoBusy === true,
      { from: mark }
    );

    const refused = await probe.send({
      type: "commit",
      sessionId,
      message: "half a tree",
      paths: ["sp ace.txt"],
    });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain("working");
    expect(await shaOf()).toBe(before);
  } finally {
    release();
  }
  await until(
    () => registry.peek(sessionId)?.status === "idle",
    "the turn to end"
  );

  expect(
    (
      await probe.send({
        type: "commit",
        sessionId,
        message: "the whole tree",
        paths: ["sp ace.txt"],
      })
    ).success
  ).toBe(true);
});
