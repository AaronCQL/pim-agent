import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

let tmp: string;
let cwd: string;
/** The default cwd; differs from the probe's so inheritance is distinguishable. */
let fallback: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

const OTHER_MODEL = "test/echo-large";

async function connect(sessionCwd = cwd): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd: sessionCwd });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

/** The `session_state` after the `attached` frame, so it belongs to the new session. */
async function stateAfterAttach(
  probe: ProbeClient,
  from: number
): Promise<ServerEvent> {
  await probe.waitFor((event) => event.type === "attached", { from });
  const at = probe.events.findLastIndex((event) => event.type === "attached");
  return await probe.waitFor((event) => event.type === "session_state", {
    from: at,
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-dirs-gateway-"));
  cwd = join(tmp, "work");
  fallback = join(tmp, "fallback");
  agentDir = join(tmp, "agent");
  await mkdir(join(cwd, "src", "nested"), { recursive: true });
  await mkdir(join(cwd, "docs"), { recursive: true });
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(join(tmp, "elsewhere"), { recursive: true });
  await mkdir(fallback, { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(join(cwd, "README.md"), "# hi\n");
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
          models: [
            { id: "echo", maxTokens: 1024, contextWindow: 8192 },
            { id: "echo-large", maxTokens: 2048, contextWindow: 16384 },
          ],
        },
      },
    })
  );
  registry = new SessionRegistry({
    defaults: { cwd: fallback, model: "test/echo" },
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
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("list_dirs answers with the directories inside one, and the way out", async () => {
  const probe = await connect();

  const response = await probe.send({ type: "list_dirs", path: cwd });

  expect(response.success).toBe(true);
  expect(response.directory?.path).toBe(cwd);
  expect(response.directory?.parent).toBe(tmp);
  // Files are excluded; hidden directories are kept for the client to filter.
  expect(response.directory?.entries.map((entry) => entry.name)).toEqual([
    ".git",
    "docs",
    "src",
  ]);
  expect(response.directory?.entries.at(-1)?.path).toBe(join(cwd, "src"));
});

test("list_dirs refuses what is not a readable directory", async () => {
  const probe = await connect();

  const file = await probe.send({
    type: "list_dirs",
    path: join(cwd, "README.md"),
  });
  const missing = await probe.send({
    type: "list_dirs",
    path: join(cwd, "nope"),
  });

  // An error, so "empty" and "missing" are distinguishable.
  expect(file.success).toBe(false);
  expect(file.error).toContain("not a directory");
  expect(missing.success).toBe(false);
  expect(missing.error).toContain("does not exist");
});

test("list_dirs refuses a path that is not rooted anywhere", async () => {
  const probe = await connect();

  const response = await probe.send({ type: "list_dirs", path: "src" });

  // A relative path would depend on the process cwd.
  expect(response.success).toBe(false);
  expect(response.error).toContain("absolute");
});

test("create_dir makes one directory, and the listing has it", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "create_dir",
    path: join(cwd, "notes"),
  });

  expect(response.success).toBe(true);
  expect(
    (await probe.send({ type: "list_dirs", path: cwd })).directory?.entries.map(
      (entry) => entry.name
    )
  ).toContain("notes");
});

test("create_dir refuses a name already taken and a parent that is missing", async () => {
  const probe = await connect();

  const taken = await probe.send({
    type: "create_dir",
    path: join(cwd, "src"),
  });
  const orphan = await probe.send({
    type: "create_dir",
    path: join(cwd, "nowhere", "deep"),
  });

  expect(taken.success).toBe(false);
  expect(taken.error).toContain("already exists");
  // One level only; a mistyped path is never created as a tree.
  expect(orphan.success).toBe(false);
  expect(orphan.error).toContain("does not exist");
  expect(
    (await probe.send({ type: "list_dirs", path: join(cwd, "nowhere") }))
      .success
  ).toBe(false);
});

test("a new session opened `like` another runs its model in its directory", async () => {
  const probe = await connect();
  const first = probe.sessionId!;
  expect(
    (
      await probe.send({
        type: "set_model",
        sessionId: first,
        value: OTHER_MODEL,
      })
    ).success
  ).toBe(true);

  const mark = probe.events.length;
  const response = await probe.send({
    type: "attach",
    like: first,
    fromSeq: 0,
  });
  const state = await stateAfterAttach(probe, mark);

  expect(response.success).toBe(true);
  expect(probe.sessionId).not.toBe(first);
  expect(state).toMatchObject({ cwd, model: OTHER_MODEL });
});

test("a directory given alongside `like` is the one that wins", async () => {
  const probe = await connect();
  const first = probe.sessionId!;
  await probe.send({ type: "set_model", sessionId: first, value: OTHER_MODEL });

  const mark = probe.events.length;
  await probe.send({
    type: "attach",
    cwd: join(tmp, "elsewhere"),
    like: first,
    fromSeq: 0,
  });

  // Model inherited, directory as requested.
  expect(await stateAfterAttach(probe, mark)).toMatchObject({
    cwd: join(tmp, "elsewhere"),
    model: OTHER_MODEL,
  });
});

test("a `like` this server has never held opens the session anyway", async () => {
  const probe = await connect();

  const mark = probe.events.length;
  const response = await probe.send({
    type: "attach",
    cwd,
    like: "00000000-0000-4000-8000-000000000000",
    fromSeq: 0,
  });

  // An unknown `like` is ignored, e.g. after a server restart.
  expect(response.success).toBe(true);
  expect(await stateAfterAttach(probe, mark)).toMatchObject({
    cwd,
    model: "test/echo",
  });
});

test("a session cannot be opened in a directory that is not one", async () => {
  const probe = await connect();
  const first = probe.sessionId;

  const response = await probe.send({
    type: "attach",
    cwd: join(cwd, "README.md"),
    fromSeq: 0,
  });

  expect(response.success).toBe(false);
  expect(response.error).toContain("not a directory");
  // The connection stays on its previous session.
  expect(probe.sessionId).toBe(first);
  expect((await probe.send({ type: "list_dirs", path: cwd })).success).toBe(
    true
  );
});
