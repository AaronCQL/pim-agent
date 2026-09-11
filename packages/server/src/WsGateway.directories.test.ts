import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

/**
 * Choosing where to work, over the wire: reading the server's directories,
 * and opening a session in one of them like the session it was asked for
 * from. No model server here — nothing in this file says anything, so the
 * provider is never called.
 */

let tmp: string;
let cwd: string;
/**
 * Where a session with nothing to go on would land. Deliberately not the one
 * the probe works in, or inheriting a directory and falling back to the
 * default would look the same.
 */
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

/**
 * The state frame that closes the replay of the attach after `from` — the
 * new session's, and not one the old session pushed on its way out. Nothing
 * on a `session_state` names its session, so the `attached` before it is
 * what makes this the right frame.
 */
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
  // Files are not places to work; hidden directories are, and are left in for
  // the client to hide until they are asked for.
  expect(response.directory?.entries.map((entry) => entry.name)).toEqual([
    ".git",
    "docs",
    "src",
  ]);
  // Located as well as named, so nothing on the client joins paths.
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

  // Refused rather than answered empty, so a client can tell "nothing in it"
  // from "no such place".
  expect(file.success).toBe(false);
  expect(file.error).toContain("not a directory");
  expect(missing.success).toBe(false);
  expect(missing.error).toContain("does not exist");
});

test("list_dirs refuses a path that is not rooted anywhere", async () => {
  const probe = await connect();

  const response = await probe.send({ type: "list_dirs", path: "src" });

  // Resolving it would mean resolving against the directory this process was
  // started in, which is an accident of the unit file and nobody's answer.
  expect(response.success).toBe(false);
  expect(response.error).toContain("absolute");
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
  // No cwd: the session being copied answers for that too.
  const response = await probe.send({
    type: "attach",
    protocolVersion: PROTOCOL_VERSION,
    like: first,
    fromSeq: 0,
  });
  const state = await stateAfterAttach(probe, mark);

  expect(response.success).toBe(true);
  expect(probe.sessionId).not.toBe(first);
  // The directory came from the session it was opened like: a new session
  // with nothing to go on would have landed in `fallback`.
  expect(state).toMatchObject({ cwd, model: OTHER_MODEL });
});

test("a directory given alongside `like` is the one that wins", async () => {
  const probe = await connect();
  const first = probe.sessionId!;
  await probe.send({ type: "set_model", sessionId: first, value: OTHER_MODEL });

  const mark = probe.events.length;
  await probe.send({
    type: "attach",
    protocolVersion: PROTOCOL_VERSION,
    cwd: join(tmp, "elsewhere"),
    like: first,
    fromSeq: 0,
  });

  // The model is inherited, the directory is the one asked for: choosing
  // where to work must not also choose what to work with.
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
    protocolVersion: PROTOCOL_VERSION,
    cwd,
    like: "00000000-0000-4000-8000-000000000000",
    fromSeq: 0,
  });

  // A hint that cannot be honoured is not a reason to refuse the session
  // being asked for — which is what a client reconnecting to a restarted
  // server would otherwise be told.
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
    protocolVersion: PROTOCOL_VERSION,
    cwd: join(cwd, "README.md"),
    fromSeq: 0,
  });

  // Pi names the log file after the directory the session was started in, so
  // a session made in one that does not exist is a conversation whose every
  // tool call fails.
  expect(response.success).toBe(false);
  expect(response.error).toContain("not a directory");
  // Refused before anything moved: the connection is still on the session it
  // was reading, rather than attached to nothing.
  expect(probe.sessionId).toBe(first);
  expect((await probe.send({ type: "list_dirs", path: cwd })).success).toBe(
    true
  );
});
