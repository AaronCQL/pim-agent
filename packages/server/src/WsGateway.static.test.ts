import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { DEFAULT_CLIENT_DIR, StaticClient } from "./StaticClient";
import { WsGateway } from "./WsGateway";

const INDEX = "<!doctype html><title>pim</title><div id=app></div>";
const SCRIPT = "console.log('pim');";
/** Over the compression floor, and repetitive the way a real bundle is. */
const BUNDLE = `${"export const paint = (block) => block.render();\n".repeat(400)}`;

let tmp: string;
let clientDir: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;

function httpUrl(): string {
  return gateway.url.replace(/^ws/, "http");
}

async function startGateway(dir: string): Promise<void> {
  gateway = new WsGateway({
    registry,
    port: 0,
    clientDir: dir,
    readCursorsPath: join(tmp, "read.json"),
  });
  gateway.start();
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-static-gateway-"));
  clientDir = join(tmp, "client");
  agentDir = join(tmp, "agent");
  await mkdir(join(clientDir, "assets"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(join(clientDir, "index.html"), INDEX);
  await Bun.write(join(clientDir, "assets", "index-abc123.js"), SCRIPT);
  await Bun.write(join(clientDir, "assets", "bundle-abc123.js"), BUNDLE);
  await Bun.write(join(tmp, "secret.txt"), "not yours");
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  registry = new SessionRegistry({ defaults: { cwd: tmp }, agentDir });
  await registry.init();
  await startGateway(clientDir);
});

afterEach(async () => {
  await gateway.stop();
  await registry.disposeAll();
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("serves index.html at the root", async () => {
  const response = await fetch(httpUrl());

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(await response.text()).toBe(INDEX);
});

test("serves a hashed asset with its own content type", async () => {
  const response = await fetch(`${httpUrl()}/assets/index-abc123.js`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("javascript");
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(await response.text()).toBe(SCRIPT);
});

test("falls back to index.html for an unknown route", async () => {
  const response = await fetch(`${httpUrl()}/sessions/deadbeef`);

  expect(response.status).toBe(200);
  expect(await response.text()).toBe(INDEX);
});

test.each([
  ["wordmark.svg", "image/svg+xml"],
  ["favicon.svg", "image/svg+xml"],
  ["apple-touch-icon.png", "image/png"],
])(
  "serves %s with its image type and revalidates its stable URL",
  async (name, type) => {
    const asset = Bun.file(
      new URL(`../../../assets/brand/${name}`, import.meta.url)
    );
    await Bun.write(join(clientDir, name), asset);

    const response = await fetch(`${httpUrl()}/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(type);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      await asset.bytes()
    );
  }
);

test("a missing asset is a 404, not the SPA shell", async () => {
  const response = await fetch(`${httpUrl()}/assets/gone-000000.js`);

  expect(response.status).toBe(404);
  expect(await response.text()).not.toBe(INDEX);
});

test.each(["br", "gzip"])(
  "compresses a bundle for a client that speaks %s",
  async (encoding) => {
    const response = await fetch(`${httpUrl()}/assets/bundle-abc123.js`, {
      headers: { "accept-encoding": encoding },
    });

    expect(response.headers.get("content-encoding")).toBe(encoding);
    expect(response.headers.get("vary")).toBe("accept-encoding");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe(BUNDLE);
  }
);

test("hands the file whole to a client that asked for no encoding", async () => {
  const response = await fetch(`${httpUrl()}/assets/bundle-abc123.js`, {
    headers: { "accept-encoding": "identity" },
  });

  expect(response.headers.get("content-encoding")).toBeNull();
  expect(response.headers.get("vary")).toBe("accept-encoding");
  expect(await response.text()).toBe(BUNDLE);
});

test("a file too small to be worth deflating is sent as it is", async () => {
  const response = await fetch(`${httpUrl()}/assets/index-abc123.js`, {
    headers: { "accept-encoding": "br, gzip" },
  });

  expect(response.headers.get("content-encoding")).toBeNull();
  expect(await response.text()).toBe(SCRIPT);
});

// Straight at the client: `fetch` decodes what it reads, so only this sees the wire size.
test("a repeat read is served the same bytes from the cache", async () => {
  const client = new StaticClient(clientDir);
  const request = new Request("http://client/assets/bundle-abc123.js", {
    headers: { "accept-encoding": "br" },
  });

  const first = await (await client.handle(request)).bytes();
  const second = await (await client.handle(request)).bytes();

  expect(first.length).toBeLessThan(BUNDLE.length / 8);
  expect(second).toEqual(first);
});

test("a traversal cannot escape the client directory", async () => {
  const escapes = [
    "/%2e%2e/secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/..%2f..%2fetc%2fpasswd",
    "/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  ];

  for (const path of escapes) {
    const response = await fetch(`${httpUrl()}${path}`);
    const body = await response.text();
    expect(body).not.toContain("not yours");
    expect(body).not.toContain("root:");
  }
});

test("the health and websocket endpoints are unchanged by static serving", async () => {
  const health = await fetch(`${httpUrl()}/health`);
  expect(((await health.json()) as { readonly ok: boolean }).ok).toBe(true);

  const socket = new WebSocket(gateway.url);
  const opened = await new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true));
    socket.addEventListener("error", () => resolve(false));
  });
  socket.close();

  expect(opened).toBe(true);
});

test("an unbuilt client answers with build instructions, not a crash", async () => {
  await gateway.stop();
  await startGateway(join(tmp, "never-built"));

  const response = await fetch(httpUrl());

  expect(response.status).toBe(503);
  expect(await response.text()).toContain("bun run web:build");
});

test("the default client directory points at the web package bundle", () => {
  expect(DEFAULT_CLIENT_DIR).toEndWith(
    join("packages", "web", "dist", "client")
  );
});
