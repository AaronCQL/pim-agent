import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { isDurableEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const REPLY = "got it";
/** A one-pixel PNG, small enough to inline. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
/** The client's own name for its bytes. It must never reach the server. */
const CLIENT_FILE = "holiday-photo.png";

let tmp: string;
let cwd: string;
let clientDir: string;
let attachmentsRoot: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let modelRequests: string[] = [];
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

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
      modelRequests.push(await req.text());
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encode = (s: string) => controller.enqueue(Buffer.from(s));
          encode(chunk({ role: "assistant", content: "" }));
          encode(chunk({ content: REPLY }));
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

async function connect(): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

function idle(probe: ProbeClient, from: number): Promise<unknown> {
  return probe.waitFor(
    (event) => event.type === "session_state" && event.status === "idle",
    { from, timeoutMs: 20_000 }
  );
}

/** Everything the agent and its clients can see, as one string. */
async function history(probe: ProbeClient): Promise<string> {
  const sessionPath = registry.peek(probe.sessionId!)?.settings.sessionPath;
  const jsonl = sessionPath ? await Bun.file(sessionPath).text() : "";
  return [
    JSON.stringify(probe.events.filter(isDurableEvent)),
    jsonl,
    modelRequests.join("\n"),
  ].join("\n");
}

beforeEach(async () => {
  startModelServer();
  modelRequests = [];
  tmp = await mkdtemp(join(tmpdir(), "pim-upload-gateway-"));
  cwd = join(tmp, "work");
  clientDir = join(tmp, "client-machine", "Pictures");
  attachmentsRoot = join(tmp, "attachments");
  agentDir = join(tmp, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(clientDir, { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(join(clientDir, CLIENT_FILE), PNG);
  await Bun.write(join(clientDir, "notes.txt"), "client side notes\n");
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
          models: [
            {
              id: "echo",
              maxTokens: 1024,
              contextWindow: 8192,
              input: ["text", "image"],
            },
          ],
        },
      },
    })
  );
  registry = new SessionRegistry({
    defaults: { cwd, model: "test/echo" },
    agentDir,
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    attachmentsRoot,
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
  await modelServer?.stop(true);
  modelServer = undefined;
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("an uploaded image reaches the agent as an image", async () => {
  const probe = await connect();
  const uploaded = await probe.upload(join(clientDir, CLIENT_FILE));

  expect(uploaded.isImage).toBe(true);
  expect(uploaded.mimeType).toBe("image/png");
  expect(dirname(uploaded.path)).toBe(join(attachmentsRoot, probe.sessionId!));
  expect(await Bun.file(uploaded.path).bytes()).toEqual(Uint8Array.from(PNG));

  const mark = probe.events.length;
  await probe.promptWith("what is this?", [{ id: uploaded.id }]);
  await idle(probe, mark);

  expect(modelRequests.join("\n")).toContain(PNG.toString("base64"));
});

test("an uploaded non-image reaches the agent as a server path", async () => {
  const probe = await connect();
  const uploaded = await probe.upload(join(clientDir, "notes.txt"));

  expect(uploaded.isImage).toBe(false);
  expect(uploaded.path).toStartWith(attachmentsRoot);

  const mark = probe.events.length;
  await probe.promptWith("read this", [{ id: uploaded.id }]);
  await idle(probe, mark);

  const user = probe.events.find(
    (event) => event.type === "message" && event.role === "user"
  );
  expect(user?.type === "message" && user.text).toBe(
    `read this\n\n[Attachment: ${uploaded.path}]`
  );
  expect(await Bun.file(uploaded.path).text()).toBe("client side notes\n");
});

// The dev client is served from another port, so its upload is cross-origin
// and only reaches the handler if the browser is told the origin is welcome.
test("an upload from another origin is allowed", async () => {
  const probe = await connect();
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(PNG)]), "image.png");
  const url = `http://127.0.0.1:${gateway.port}/upload?session=${probe.sessionId}`;
  const response = await fetch(url, {
    method: "POST",
    body: form,
    headers: { origin: "http://localhost:5173" },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");

  const preflight = await fetch(url, {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5173" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
});

test("no client-local path ever enters the conversation", async () => {
  const probe = await connect();
  const image = await probe.upload(join(clientDir, CLIENT_FILE));
  const document = await probe.upload(join(clientDir, "notes.txt"));

  const mark = probe.events.length;
  await probe.promptWith("both, please", [
    { id: image.id },
    { id: document.id },
  ]);
  await idle(probe, mark);

  const seen = await history(probe);
  expect(seen).not.toContain(clientDir);
  expect(seen).not.toContain(CLIENT_FILE);
  expect(seen).not.toContain("notes.txt");
  expect(seen).toContain(document.path);
});

test("an id can only be spent once", async () => {
  const probe = await connect();
  const uploaded = await probe.upload(join(clientDir, "notes.txt"));

  let mark = probe.events.length;
  await probe.promptWith("first", [{ id: uploaded.id }]);
  await idle(probe, mark);

  mark = probe.events.length;
  await probe.promptWith("second", [{ id: uploaded.id }]);
  await idle(probe, mark);

  const last = probe.events
    .filter((event) => event.type === "message" && event.role === "user")
    .at(-1);
  expect(last?.type === "message" && last.text).toBe("second");
});

test("refuses an upload past the size limit", async () => {
  const probe = await connect();

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(32 * 1024 * 1024)]), "x.bin");
  const response = await fetch(
    `${probe.httpUrl}/upload?session=${probe.sessionId!}`,
    { method: "POST", body: form }
  );

  expect(response.status).toBe(413);
});

test("rejects an upload with no session and a traversing filename", async () => {
  const probe = await connect();

  const missing = await fetch(`${probe.httpUrl}/upload`, {
    method: "POST",
    body: new FormData(),
  });
  expect(missing.status).toBe(400);

  const form = new FormData();
  form.append("file", new Blob(["x"]), "../../../../etc/passwd");
  const traversal = await fetch(
    `${probe.httpUrl}/upload?session=${probe.sessionId!}`,
    { method: "POST", body: form }
  );
  const body = (await traversal.json()) as { readonly path: string };
  expect(traversal.status).toBe(200);
  expect(dirname(body.path)).toBe(join(attachmentsRoot, probe.sessionId!));
});
