import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { until } from "#core/shared/fixtures/wait";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import { Proc } from "#core/shared/Proc";
import { SessionRegistry } from "#core/session/SessionRegistry";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";
import { startModelServer, type ModelServer } from "./fixtures/modelServer";
import { sessionOf } from "./fixtures/probe";

let tmp: string;
let cwd: string;
let inner: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];
let model: ModelServer;

async function connect(at = cwd): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd: at });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

function stateOf(
  event: ServerEvent
): Extract<ServerEvent, { readonly type: "session_state" }> | undefined {
  return event.type === "session_state" ? event : undefined;
}

/** The reply comes after the state that reports the repository, read whole. */
async function chooseInner(probe: ProbeClient): Promise<void> {
  const from = probe.events.length;
  const response = await probe.send({
    type: "set_repo",
    sessionId: sessionOf(probe),
    repo: "inner",
  });
  expect(response.success).toBe(true);
  const reported = probe.events
    .slice(from)
    .flatMap((event) => stateOf(event) ?? [])
    .filter((state) => state.repo === "inner");
  expect(reported.length).toBeGreaterThan(0);
  expect(reported.map((state) => state.branch)).not.toContain(undefined);
  expect(reported.at(-1)?.branch).toBe("feat/inner");
}

async function statusIn(dir: string): Promise<string> {
  const { stdout } = await Proc.run(["git", "status", "--porcelain"], {
    cwd: dir,
  });
  return stdout.trim();
}

async function branchIn(dir: string): Promise<string> {
  const { stdout } = await Proc.run(["git", "branch", "--show-current"], {
    cwd: dir,
  });
  return stdout.trim();
}

beforeEach(async () => {
  model = startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-repos-gateway-"));
  cwd = join(tmp, "work");
  inner = join(cwd, "inner");
  agentDir = join(tmp, "agent");
  await mkdir(inner, { recursive: true });
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

  await makeRepo(cwd, ["outer-feature"]);
  await Bun.write(join(cwd, ".git/info/exclude"), "inner/\n");
  await makeRepo(inner, ["feat/inner"]);
  // The gateway's own commit sees no fixture identity, and CI has no global one.
  await git(inner, ["config", "user.email", "pim@example.com"]);
  await git(inner, ["config", "user.name", "pim"]);
  await Bun.write(join(inner, "fresh.txt"), "new\n");
  await mkdir(join(cwd, "plain"));
  await Bun.write(join(cwd, "plain/notes.md"), "# notes\n");
  await mkdir(join(tmp, "outside"));
  await makeRepo(join(tmp, "outside"));
  await Bun.write(join(tmp, "outside/secret.txt"), "outside\n");
  await symlink(join(tmp, "outside"), join(cwd, "link"));

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
  await model.stop();
  await registry.disposeAll();
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("list_repos answers the repository the cwd's own ignores hide", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "list_repos",
    sessionId: sessionOf(probe),
  });

  expect(response.repos).toEqual(["inner"]);
});

test("set_repo refuses anything but a plain path to a repository inside the cwd", async () => {
  const probe = await connect();
  const from = probe.events.length;

  for (const repo of [
    "..",
    "../outside",
    "link",
    "plain",
    tmp,
    "missing",
    "./inner",
    "inner/",
    "inner/.",
    "plain/../inner",
  ]) {
    const response = await probe.send({
      type: "set_repo",
      sessionId: sessionOf(probe),
      repo,
    });
    expect(response.success).toBe(false);
  }

  const branches = await probe.send({
    type: "list_branches",
    sessionId: sessionOf(probe),
  });
  expect(branches.branches?.find((branch) => branch.current)?.name).toBe(
    "outer-feature"
  );
  expect(
    probe.events.slice(from).some((event) => stateOf(event)?.repo !== undefined)
  ).toBe(false);
});

test("set_repo takes a repository the walk would never reach, and the cwd back", async () => {
  await mkdir(join(cwd, "vendor/dep"), { recursive: true });
  await makeRepo(join(cwd, "vendor/dep"));
  await Bun.write(join(cwd, ".git/info/exclude"), "inner/\nvendor/\n");
  const probe = await connect();

  const deep = await probe.send({
    type: "set_repo",
    sessionId: sessionOf(probe),
    repo: "vendor/dep",
  });
  const back = await probe.send({
    type: "set_repo",
    sessionId: sessionOf(probe),
    repo: "",
  });

  expect(deep.success).toBe(true);
  expect(back.success).toBe(true);
  const last = probe.events.flatMap((event) => stateOf(event) ?? []).at(-1);
  expect(last?.repo).toBeUndefined();
  expect(last?.branch).toBe("outer-feature");
});

test("the chosen repository's branch and changes come with cwd-relative paths", async () => {
  const probe = await connect();
  await chooseInner(probe);

  const branches = await probe.send({
    type: "list_branches",
    sessionId: sessionOf(probe),
  });
  const changes = await probe.send({
    type: "list_changes",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
  });
  const diff = await probe.send({
    type: "file_diff",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
    path: "inner/fresh.txt",
  });

  expect(branches.branches?.find((branch) => branch.current)?.name).toBe(
    "feat/inner"
  );
  expect(changes.changes?.files.map((file) => file.path)).toEqual([
    "inner/fresh.txt",
  ]);
  expect(diff.fileDiff?.path).toBe("inner/fresh.txt");
  expect(diff.fileDiff?.hunks[0]?.lines[0]?.text).toBe("new");
});

test("a path outside the chosen repository is refused", async () => {
  const probe = await connect();
  await chooseInner(probe);

  const response = await probe.send({
    type: "file_diff",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
    path: "plain/notes.md",
  });

  expect(response.success).toBe(false);
  expect(response.error).toContain("outside the repository inner");
});

test("read_lines and file_diff never read a path that climbs out of the cwd", async () => {
  await Bun.write(join(tmp, "secret.txt"), "TOP SECRET\n");
  const probe = await connect();

  for (const [repo, path] of [
    ["", "../secret.txt"],
    ["", "plain/../../secret.txt"],
    ["inner", "inner/../../secret.txt"],
    ["inner", "inner/../plain/notes.md"],
  ] as const) {
    await probe.send({ type: "set_repo", sessionId: sessionOf(probe), repo });
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
    expect(lines.error).toContain("is not a path inside the working directory");
    expect(diff.success).toBe(false);
    expect(JSON.stringify([lines, diff])).not.toContain("SECRET");
  }
});

test("an error names the path the way the cwd does", async () => {
  const probe = await connect();
  await chooseInner(probe);

  const response = await probe.send({
    type: "read_lines",
    sessionId: sessionOf(probe),
    base: { kind: "worktree" },
    path: "inner/gone.txt",
    spans: [{ start: 1, end: 1 }],
  });

  expect(response.error).toBe("could not read inner/gone.txt");
});

test("commit lands in the chosen repository and leaves the cwd's alone", async () => {
  const probe = await connect();
  await chooseInner(probe);
  const outer = await statusIn(cwd);

  const response = await probe.send({
    type: "commit",
    sessionId: sessionOf(probe),
    message: "inner change",
    paths: ["inner/fresh.txt"],
    repo: "inner",
  });

  expect(response.success).toBe(true);
  expect(await statusIn(inner)).toBe("");
  expect(await statusIn(cwd)).toBe(outer);
});

test("a tree-moving command meant for another repository is refused", async () => {
  const probe = await connect();
  await chooseInner(probe);
  const sessionId = sessionOf(probe);

  const checkout = await probe.send({
    type: "checkout",
    sessionId,
    branch: "main",
    repo: "",
  });
  const commit = await probe.send({
    type: "commit",
    sessionId,
    message: "meant for the cwd",
    paths: ["inner/fresh.txt"],
    repo: "",
  });
  const pull = await probe.send({ type: "pull", sessionId, repo: "" });
  const push = await probe.send({ type: "push", sessionId, repo: "" });

  for (const response of [checkout, commit, pull, push]) {
    expect(response.success).toBe(false);
    expect(response.error).toBe("the session's repository changed to inner");
  }
  expect(await branchIn(inner)).toBe("feat/inner");
  expect(await statusIn(inner)).toBe("?? fresh.txt");
});

test("a chosen repository whose .git is gone is dropped, and nothing runs in the cwd's in its name", async () => {
  const probe = await connect();
  await chooseInner(probe);
  const from = probe.events.length;
  await rm(join(inner, ".git"), { recursive: true });

  const response = await probe.send({
    type: "checkout",
    sessionId: sessionOf(probe),
    branch: "main",
    repo: "inner",
  });

  expect(response.success).toBe(false);
  expect(response.error).toMatch(
    /^(?:inner is no longer a git repository|the session's repository changed to the working directory)$/
  );
  expect(await branchIn(cwd)).toBe("outer-feature");
  const dropped = await probe.waitFor(
    (event) => stateOf(event)?.branch === "outer-feature",
    { from }
  );
  expect(stateOf(dropped)?.repo).toBeUndefined();
  expect(
    probe.events
      .slice(from)
      .some(
        (event) =>
          stateOf(event)?.repo === "inner" &&
          stateOf(event)?.branch === "outer-feature"
      )
  ).toBe(false);
});

test("the first command to find the chosen .git gone says so", async () => {
  const probe = await connect();
  await chooseInner(probe);
  await rm(join(inner, ".git"), { recursive: true });

  const responses = await Promise.all(
    ["list_branches", "list_branches"].map(() =>
      probe.send({ type: "list_branches", sessionId: sessionOf(probe) })
    )
  );

  expect(responses.map((response) => response.error)).toContain(
    "inner is no longer a git repository"
  );
});

test("an agent working inside the chosen repository holds it", async () => {
  const probe = await connect();
  await chooseInner(probe);
  const sessionId = sessionOf(probe);
  const worker = await connect(inner);
  const mark = probe.events.length;
  const release = model.holdTurn();
  try {
    await worker.prompt("edit the nested repo");
    await probe.waitFor((event) => stateOf(event)?.repoBusy === true, {
      from: mark,
    });

    const refused = await probe.send({
      type: "checkout",
      sessionId,
      branch: "main",
      repo: "inner",
    });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain(
      `"edit the nested repo" (mid-turn) is working in ${inner}`
    );
    expect(await branchIn(inner)).toBe("feat/inner");
  } finally {
    release();
  }
  await until(
    () => registry.peek(sessionOf(worker))?.status === "idle",
    "the turn to end"
  );
});

test("an agent working in a sibling directory leaves the chosen repository free", async () => {
  const probe = await connect();
  await chooseInner(probe);
  const worker = await connect(join(cwd, "plain"));
  const release = model.holdTurn();
  try {
    await worker.prompt("edit the notes");
    await until(
      () => registry.peek(sessionOf(worker))?.status !== "idle",
      "the turn to start"
    );

    const checkout = await probe.send({
      type: "checkout",
      sessionId: sessionOf(probe),
      branch: "main",
      repo: "inner",
    });

    expect(checkout.success).toBe(true);
    expect(await branchIn(inner)).toBe("main");
  } finally {
    release();
  }
  await until(
    () => registry.peek(sessionOf(worker))?.status === "idle",
    "the turn to end"
  );
});

test("moving the cwd drops the chosen repository", async () => {
  const probe = await connect();
  await chooseInner(probe);
  const from = probe.events.length;

  const response = await probe.send({
    type: "set_cwd",
    sessionId: sessionOf(probe),
    value: join(cwd, "plain"),
  });

  expect(response.success).toBe(true);
  const moved = await probe.waitFor(
    (event) => stateOf(event)?.cwd === join(cwd, "plain"),
    { from }
  );
  expect(stateOf(moved)?.repo).toBeUndefined();

  const back = probe.events.length;
  await probe.send({
    type: "set_cwd",
    sessionId: sessionOf(probe),
    value: cwd,
  });
  const returned = await probe.waitFor((event) => stateOf(event)?.cwd === cwd, {
    from: back,
  });
  expect(stateOf(returned)?.repo).toBeUndefined();
});
