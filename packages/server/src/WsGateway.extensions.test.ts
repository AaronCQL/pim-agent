import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import type { SessionHost } from "#core/session/SessionHost";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { usePimHome } from "#core/shared/fixtures/home";
import { until } from "#core/shared/fixtures/wait";
import type { ExtensionEntry } from "#core/shared/PiExtensions";
import type { ResponseEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

/**
 * The extension roster over the wire, read against a temp agent dir: pi's own
 * resolver answers for the file planted below, so nothing here reads the
 * extensions this machine actually has.
 */

usePimHome("pim-extensions-gateway-home-");

let tmp: string;
let agentDir: string;
let plantedId: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];
let releaseQueue: (() => void) | undefined;

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

async function roster(probe: ProbeClient): Promise<readonly ExtensionEntry[]> {
  const response = await probe.send({ type: "list_extensions" });
  expect(response.success).toBe(true);
  return response.extensions ?? [];
}

function entryFor(
  entries: readonly ExtensionEntry[],
  id: string
): ExtensionEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

/** Occupies a host's turn queue until the test lets go, the way a turn would. */
function holdQueue(host: SessionHost): Promise<void> {
  const held = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  return host.serialize(() => held);
}

beforeEach(async () => {
  tmp = await realpath(
    await mkdtemp(join(tmpdir(), "pim-extensions-gateway-"))
  );
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(
    join(agentDir, "extensions", "probe.ts"),
    "export default () => {};\n"
  );
  plantedId = `pi:${join(agentDir, "extensions", "probe.ts")}`;
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
  });
  gateway.start();
});

afterEach(async () => {
  for (const probe of probes) {
    probe.close();
  }
  probes = [];
  releaseQueue?.();
  releaseQueue = undefined;
  await gateway.stop();
  await registry.disposeAll();
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("answers with the pim allowlist and the extensions in the agent dir", async () => {
  const probe = await connect();

  const entries = await roster(probe);

  expect(
    entries.filter((entry) => entry.group === "pim").map((entry) => entry.id)
  ).toEqual(["pim:todo"]);
  // The roster is the allowlist, not pim's roster: a tool extension is not switchable from here.
  expect(entries.some((entry) => entry.id === "pim:bash")).toBe(false);
  expect(entryFor(entries, plantedId)).toMatchObject({
    label: "probe",
    group: "user",
    enabled: true,
    writable: true,
  });
});

test("switches an extension off and says so to every client", async () => {
  const first = await connect();
  const second = await connect(first.sessionId!);
  const mark = second.events.length;

  const response = await first.send({
    type: "set_extension",
    extensionId: plantedId,
    value: false,
  });

  expect(response.success).toBe(true);
  await second.waitFor((event) => event.type === "extensions_changed", {
    from: mark,
  });
  expect(entryFor(await roster(first), plantedId)?.enabled).toBe(false);

  expect(
    (
      await first.send({
        type: "set_extension",
        extensionId: plantedId,
        value: true,
      })
    ).success
  ).toBe(true);
  expect(entryFor(await roster(first), plantedId)?.enabled).toBe(true);
});

test("refuses an unknown extension and keeps answering afterwards", async () => {
  const probe = await connect();

  const refused: ResponseEvent = await probe.send({
    type: "set_extension",
    extensionId: "pi:/nope/missing.ts",
    value: false,
  });

  expect(refused.success).toBe(false);
  expect(refused.error).toContain("pi:/nope/missing.ts");
  // Nothing was switched, so nothing was announced.
  expect(
    probe.events.some((event) => event.type === "extensions_changed")
  ).toBe(false);
  expect(entryFor(await roster(probe), plantedId)?.enabled).toBe(true);
});

test("drops a live session's agent behind the turn it is running", async () => {
  const probe = await connect();
  const host = registry.peek(probe.sessionId!)!;
  expect(host.agentSession).toBeDefined();
  const holding = holdQueue(host);

  await probe.send({
    type: "set_extension",
    extensionId: plantedId,
    value: false,
  });

  // Queued behind the work holding the session, rather than taken from under it.
  expect(host.agentSession).toBeDefined();
  releaseQueue?.();
  await holding;
  await until(
    () => host.agentSession === undefined,
    "the session to let its agent go"
  );
});
