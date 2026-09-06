import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Type } from "typebox";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { Tools, type PimToolDefinition } from "#core/shared/Tools";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const REPLY = "all done";
/** Roughly this repository's tracked file count, generated on the fly. */
const BIG_TREE_FILES = 1400;

let tmp: string;
let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

const writeSchema = Type.Object({ path: Type.String() });

/** Tier 2: runs unattended, and moves what the file picker would answer. */
function writeTool(): PimToolDefinition<typeof writeSchema, { path: string }> {
  return {
    name: "put_file",
    label: "put_file",
    description: "create a file",
    parameters: writeSchema,
    effect: { kind: "writesPaths", paths: ({ path }) => [path] },
    execute: async (_id, params) => {
      const target = join(cwd, params.path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, "written\n");
      return {
        content: [{ type: "text" as const, text: `wrote ${params.path}` }],
        details: { path: params.path },
      };
    },
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

function startModelServer(): void {
  modelServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as {
        readonly messages: readonly { readonly role: string }[];
      };
      const isToolTurn = body.messages.at(-1)?.role !== "tool";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encode = (s: string) => controller.enqueue(Buffer.from(s));
          encode(chunk({ role: "assistant", content: "" }));
          if (isToolTurn) {
            encode(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "put_file",
                      arguments: JSON.stringify({ path: "src/Fresh.ts" }),
                    },
                  },
                ],
              })
            );
            encode(chunk({}, "tool_calls"));
          } else {
            encode(chunk({ content: REPLY }));
            encode(chunk({}, "stop"));
          }
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

async function connect(debounceMs = 0): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd, debounceMs });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

function idle(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) => event.type === "session_state" && event.status === "idle",
    { from, timeoutMs: 20_000 }
  );
}

async function skill(
  root: string,
  name: string,
  description: string
): Promise<void> {
  await mkdir(join(root, ".pi", "skills", name), { recursive: true });
  await Bun.write(
    join(root, ".pi", "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`
  );
}

beforeEach(async () => {
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-picker-gateway-"));
  cwd = join(tmp, "work");
  agentDir = join(tmp, "agent");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(join(cwd, "src", "Renderer.ts"), "export {};\n");
  await Bun.write(join(cwd, "src", "Router.ts"), "export {};\n");
  await Bun.write(join(cwd, "README.md"), "# hi\n");
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
    defaults: { cwd, model: "test/echo" },
    agentDir,
    customTools: () => [Tools.wrap(writeTool()) as unknown as ToolDefinition],
  });
  await registry.init();
  gateway = new WsGateway({ registry, port: 0 });
  gateway.start();
});

afterEach(async () => {
  for (const probe of probes) {
    probe.close();
  }
  probes = [];
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

test("completes an @ path over the wire, ranked on the server", async () => {
  const probe = await connect();

  const items = await probe.files.rank("Rend", { limit: 10 });

  expect(items?.[0]?.value).toBe("src/Renderer.ts");
  expect(items?.[0]?.description).toBe("src/Renderer.ts");
});

test("ships rows, never a catalog", async () => {
  const probe = await connect();

  await probe.files.rank("", { limit: 2 });

  const response = probe.events.find(
    (event) => event.type === "response" && event.items !== undefined
  );
  expect(response?.type === "response" && response.items).toHaveLength(2);
  // Everything past the limit stayed on the server, catalog included.
  expect(JSON.stringify(probe.events)).not.toContain("Router.ts");
});

test("answers pick_commands with skills from the session cwd", async () => {
  await skill(cwd, "deploy", "Ship the thing.");
  const probe = await connect();

  const items = await probe.pickCommands("dep");

  expect(items.map((item) => item.value)).toEqual(["/skill:deploy"]);
  expect(items[0]?.description).toBe("Ship the thing.");
});

test("moving the cwd invalidates every client's picker cache", async () => {
  await skill(cwd, "deploy", "Ship the thing.");
  const elsewhere = join(tmp, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await Bun.write(join(elsewhere, "Moved.ts"), "export {};\n");
  await skill(elsewhere, "migrate", "Move the data.");

  const probe = await connect();
  expect((await probe.files.rank("Rend", { limit: 10 }))?.[0]?.value).toBe(
    "src/Renderer.ts"
  );

  const mark = probe.events.length;
  await probe.send({
    type: "set_cwd",
    sessionId: probe.sessionId!,
    value: elsewhere,
  });
  const invalidated = await probe.waitFor(
    (event) => event.type === "picker_invalidate",
    { from: mark }
  );
  expect(invalidated).toMatchObject({ scope: "all", cwd: elsewhere });

  expect((await probe.files.rank("Rend", { limit: 10 }))?.length).toBe(0);
  expect((await probe.files.rank("Moved", { limit: 10 }))?.[0]?.value).toBe(
    "Moved.ts"
  );
  expect((await probe.pickCommands("")).map((item) => item.value)).toEqual([
    "/skill:migrate",
  ]);
});

test("a tool that writes invalidates the picker without a watcher", async () => {
  const probe = await connect();
  expect(await probe.files.rank("Fresh", { limit: 10 })).toEqual([]);

  const mark = probe.events.length;
  await probe.prompt("make a file");
  await idle(probe, mark);

  expect(
    probe.events
      .slice(mark)
      .some(
        (event) => event.type === "picker_invalidate" && event.scope === "files"
      )
  ).toBe(true);
  expect((await probe.files.rank("Fresh", { limit: 10 }))?.[0]?.value).toBe(
    "src/Fresh.ts"
  );
});

test("stays well under 100ms per keystroke on a repo-sized tree", async () => {
  await Promise.all(
    Array.from({ length: BIG_TREE_FILES }, (_, i) =>
      Bun.write(
        join(cwd, "pkg", `dir${String(i % 40)}`, `Module${String(i)}.ts`),
        "export {};\n"
      )
    )
  );

  const probe = await connect();
  const cold = Bun.nanoseconds();
  await probe.files.rank("Module1", { limit: 50 });
  const coldMs = (Bun.nanoseconds() - cold) / 1e6;

  const warm: number[] = [];
  for (const query of ["Mod", "Modu", "Module7", "dir3/Mo", "Module42"]) {
    const started = Bun.nanoseconds();
    const items = await probe.files.rank(query, { limit: 50 });
    warm.push((Bun.nanoseconds() - started) / 1e6);
    expect(items?.length).toBeGreaterThan(0);
  }

  const slowest = Math.max(...warm);
  // The timings are only worth reading when they are heading for the budget;
  // printed every run they are a number nobody compares against anything.
  if (slowest > 50) {
    console.log(
      `[picker] ${String(BIG_TREE_FILES)} files: cold ${coldMs.toFixed(1)}ms, warm max ${slowest.toFixed(1)}ms, warm ${warm.map((ms) => ms.toFixed(1)).join("/")}ms`
    );
  }
  expect(slowest).toBeLessThan(100);
});
