import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import { SessionRegistry } from "#core/session/SessionRegistry";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

/**
 * The repository half of a session, over the wire: what the branch menu lists,
 * what it is allowed to do, and what git says when it refuses. No model server
 * here — nothing in this file takes a turn.
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

function branchIn(event: ServerEvent): string | undefined {
  return event.type === "session_state" ? event.branch : undefined;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-git-gateway-"));
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

  await makeRepo(cwd, ["feat/work"]);
  await git(cwd, ["checkout", "main"]);

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

test("list_branches answers the session's repository, trunk first", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "list_branches",
    sessionId: sessionOf(probe),
  });

  expect(response.success).toBe(true);
  expect(response.branches?.map((branch) => branch.name)).toEqual([
    "main",
    "feat/work",
  ]);
  expect(response.branches?.[0]).toMatchObject({
    isDefault: true,
    current: true,
  });
});

test("a checkout moves the session's branch and says so unprompted", async () => {
  const probe = await connect();
  const from = probe.events.length;

  const response = await probe.send({
    type: "checkout",
    sessionId: sessionOf(probe),
    branch: "feat/work",
  });

  expect(response.success).toBe(true);
  const moved = await probe.waitFor(
    (event) => branchIn(event) === "feat/work",
    { from }
  );
  expect(branchIn(moved)).toBe("feat/work");
});

test("a checkout git refuses comes back in git's own words", async () => {
  const probe = await connect();
  await Bun.write(join(cwd, "file.txt"), "uncommitted\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "second"]);
  await git(cwd, ["checkout", "feat/work"]);
  await Bun.write(join(cwd, "file.txt"), "conflicting\n");

  const response = await probe.send({
    type: "checkout",
    sessionId: sessionOf(probe),
    branch: "main",
  });

  expect(response.success).toBe(false);
  expect(response.error).toContain("would be overwritten");
});

test("push names the missing remote rather than waiting on a prompt", async () => {
  const probe = await connect();

  const response = await probe.send({
    type: "push",
    sessionId: sessionOf(probe),
  });

  expect(response.success).toBe(false);
  expect(response.error).toContain("no remote");
});

test("refresh_git re-reads a repository that moved behind the server's back", async () => {
  const probe = await connect();
  await probe.waitFor((event) => branchIn(event) === "main");
  const from = probe.events.length;

  await git(cwd, ["checkout", "feat/work"]);
  await probe.send({ type: "refresh_git", sessionId: sessionOf(probe) });

  const moved = await probe.waitFor(
    (event) => branchIn(event) === "feat/work",
    { from }
  );
  expect(branchIn(moved)).toBe("feat/work");
});

test("two sessions in one directory hear the same checkout", async () => {
  const first = await connect();
  const second = await connect();
  await second.waitFor((event) => branchIn(event) === "main");
  const from = second.events.length;

  expect(
    (
      await first.send({
        type: "checkout",
        sessionId: sessionOf(first),
        branch: "feat/work",
      })
    ).success
  ).toBe(true);

  const moved = await second.waitFor(
    (event) => branchIn(event) === "feat/work",
    { from }
  );
  expect(branchIn(moved)).toBe("feat/work");
});

test("a branch moving drops the file pickers pointed at the old one", async () => {
  const probe = await connect();
  await probe.waitFor((event) => branchIn(event) === "main");
  const from = probe.events.length;

  // Not through the gateway: a checkout in a terminal invalidates just the same.
  await git(cwd, ["checkout", "feat/work"]);

  await probe.waitFor(
    (event) => event.type === "picker_invalidate" && event.scope === "files",
    { from }
  );
});
