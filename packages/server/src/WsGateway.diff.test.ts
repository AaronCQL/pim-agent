import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import { Proc } from "#core/shared/Proc";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";
import { startModelServer, type ModelServer } from "./fixtures/modelServer";
import { sessionOf } from "./fixtures/probe";
import { until } from "#core/shared/fixtures/wait";

let tmp: string;
let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];
let model: ModelServer;

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

async function connect(at = cwd): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd: at });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

beforeEach(async () => {
  model = startModelServer();
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
          baseUrl: `http://localhost:${model.port}/v1`,
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
    sessionMetaPath: join(tmp, "sessions.json"),
  });
  gateway.start();
});

afterEach(async () => {
  for (const probe of probes) {
    probe.close();
  }
  probes = [];
  await gateway.stop();
  await registry.disposeAll();
  await model.stop();
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
  const release = model.holdTurn();
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
    expect(refused.error).toContain('"edit something" (mid-turn) is working');
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

test("an agent working below the cwd holds its repository too", async () => {
  await mkdir(join(cwd, "sub"));
  const probe = await connect();
  const worker = await connect(join(cwd, "sub"));
  const mark = probe.events.length;
  const release = model.holdTurn();
  try {
    await worker.prompt("edit below");
    await probe.waitFor(
      (event) => event.type === "session_state" && event.repoBusy === true,
      { from: mark }
    );

    const refused = await probe.send({
      type: "commit",
      sessionId: sessionOf(probe),
      message: "under its feet",
      paths: ["sp ace.txt"],
    });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain('"edit below" (mid-turn) is working');
  } finally {
    release();
  }
  await until(
    () => registry.peek(sessionOf(worker))?.status === "idle",
    "the turn to end"
  );
});

test("read_lines and file_diff never read a path that climbs out of the cwd", async () => {
  await Bun.write(join(tmp, "secret.txt"), "TOP SECRET\n");
  const probe = await connect();

  for (const path of ["../secret.txt", "sub/../../secret.txt"]) {
    const lines = await probe.send({
      type: "read_lines",
      sessionId: sessionOf(probe),
      base: { kind: "worktree" },
      path,
      spans: [{ start: 1, end: 5 }],
    });
    const diff = await probe.send({
      type: "file_diff",
      sessionId: sessionOf(probe),
      base: { kind: "worktree" },
      path,
    });

    expect(lines.success).toBe(false);
    expect(diff.success).toBe(false);
    expect(JSON.stringify([lines, diff])).not.toContain("SECRET");
  }
});

test("list_files answers the working tree's files", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "list_files",
    sessionId: sessionOf(probe),
  });

  expect(response.success).toBe(true);
  expect(response.files).toEqual({ paths: ["loose.txt", "sp ace.txt"] });
});

test("read_file answers a file's text, and refuses one outside the cwd", async () => {
  const probe = await connect();

  const read = await probe.send({
    type: "read_file",
    sessionId: sessionOf(probe),
    path: "sp ace.txt",
  });
  const escaped = await probe.send({
    type: "read_file",
    sessionId: sessionOf(probe),
    path: "../agent/models.json",
  });

  expect(read.file).toMatchObject({
    path: "sp ace.txt",
    text: "one\ntwo\nthree\n",
  });
  expect(escaped.success).toBe(false);
  expect(escaped.error).toContain("outside");
});
