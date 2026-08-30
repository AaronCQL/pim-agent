import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "./SessionRegistry";

const FIXTURE = join(import.meta.dir, "fixtures", "pi-session-v3.jsonl");
const FIXTURE_ID = "019fbcd4-6fe8-78eb-914d-6a736b04203e";
const FIXTURE_CWD = "/home/htpc/Desktop/dev/mmorpg";

let tmp: string;
let agentDir: string;
let registry: SessionRegistry;
let previousAgentDir: string | undefined;

async function seed(
  dir: string,
  name: string,
  header?: { readonly id: string; readonly cwd: string }
): Promise<string> {
  const path = join(agentDir, "sessions", dir, name);
  await mkdir(join(agentDir, "sessions", dir), { recursive: true });
  const lines = (await Bun.file(FIXTURE).text()).split("\n");
  if (header) {
    lines[0] = JSON.stringify({
      ...JSON.parse(lines[0]!),
      id: header.id,
      cwd: header.cwd,
    });
  }
  await Bun.write(path, lines.join("\n"));
  return path;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-registry-test-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  // Pi picks the directory for a new session itself; this is its own knob.
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  registry = new SessionRegistry({
    defaults: { cwd: tmp },
    agentDir,
  });
  await registry.init();
});

afterEach(async () => {
  await registry.disposeAll();
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("lists pi's on-disk cwd grouping without a store of its own", async () => {
  const path = await seed(
    "--home-htpc-Desktop-dev-mmorpg--",
    `2026-08-01T10-17-46-728Z_${FIXTURE_ID}.jsonl`
  );
  await seed("--tmp-other--", "2026-08-02T00-00-00-000Z_other.jsonl", {
    id: "other",
    cwd: "/tmp/other",
  });

  const all = await registry.list();
  expect(all.map((s) => s.sessionId).sort()).toEqual([FIXTURE_ID, "other"]);

  const scoped = await registry.list(FIXTURE_CWD);
  expect(scoped).toEqual([
    {
      sessionId: FIXTURE_ID,
      cwd: FIXTURE_CWD,
      path,
      createdAt: Date.parse("2026-08-01T10:17:46.728Z"),
      modifiedAt: expect.any(Number),
    },
  ]);
  expect(await registry.list("/nowhere")).toEqual([]);
});

test("ignores files that are not pi sessions", async () => {
  await mkdir(join(agentDir, "sessions", "--junk--"), { recursive: true });
  await Bun.write(join(agentDir, "sessions", "--junk--", "a.jsonl"), "nope\n");
  await Bun.write(join(agentDir, "sessions", "--junk--", "b.jsonl"), "");

  expect(await registry.list()).toEqual([]);
});

test("an empty sessions root lists nothing", async () => {
  expect(await registry.list()).toEqual([]);
});

test("opens an existing session by pi's uuid and caches it under that key", async () => {
  const path = await seed(
    "--home-htpc-Desktop-dev-mmorpg--",
    `2026-08-01T10-17-46-728Z_${FIXTURE_ID}.jsonl`
  );

  expect(registry.peek(FIXTURE_ID)).toBeUndefined();
  const host = await registry.open(FIXTURE_ID);

  expect(registry.peek(FIXTURE_ID)).toBe(host);
  expect(await registry.open(FIXTURE_ID)).toBe(host);
  expect(host.settings.sessionPath).toBe(path);
  expect(host.cwd).toBe(FIXTURE_CWD);
});

test("creates a session under the uuid pi assigns it", async () => {
  const host = await registry.create(tmp);

  const sessionId = host.sessionId;
  expect(sessionId).toBeString();
  expect(registry.peek(sessionId!)).toBe(host);
  expect(host.settings.sessionPath).toStartWith(
    join(agentDir, "sessions", "--")
  );
  // Pi withholds the file until the first assistant message, so a brand new
  // session is not listable yet — nothing durable has happened.
  expect(await registry.list()).toEqual([]);
});

test("rejects an unknown session id", async () => {
  expect(registry.open("nope")).rejects.toThrow("unknown session: nope");
});

test("requires init before building a host", async () => {
  const fresh = new SessionRegistry({ defaults: { cwd: tmp }, agentDir });
  expect(fresh.create()).rejects.toThrow(
    "SessionRegistry.init() must complete before use"
  );
});
