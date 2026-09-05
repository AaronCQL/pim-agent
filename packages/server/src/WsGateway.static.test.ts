import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { DEFAULT_CLIENT_DIR } from "./StaticClient";
import { WsGateway } from "./WsGateway";

const INDEX = "<!doctype html><title>pim</title><div id=app></div>";
const SCRIPT = "console.log('pim');";

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
  gateway = new WsGateway({ registry, port: 0, clientDir: dir });
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

test("a missing asset is a 404, not the SPA shell", async () => {
  const response = await fetch(`${httpUrl()}/assets/gone-000000.js`);

  expect(response.status).toBe(404);
  expect(await response.text()).not.toBe(INDEX);
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
  expect(await response.text()).toContain("bun run build:web");
});

test("the default client directory points at the web package bundle", () => {
  expect(DEFAULT_CLIENT_DIR).toEndWith(
    join("packages", "web", "dist", "client")
  );
});
