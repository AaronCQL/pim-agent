import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

/**
 * The change set of a session's repository, over the wire: what the diff
 * overlay lists and what it gets when it expands a row.
 */

let tmp: string;
let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

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
          baseUrl: "http://localhost:1/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "echo", maxTokens: 1024, contextWindow: 8192 }],
        },
      },
    })
  );

  await makeRepo(cwd);
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
  await gateway.stop();
  await registry.disposeAll();
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
