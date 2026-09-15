import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { EventLog } from "./EventLog";
import { SessionLease } from "./SessionLease";
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

test("lists every session past the gate the header scan fans out through", async () => {
  const count = 64;
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      seed("--tmp-many--", `2026-08-02T00-00-00-000Z_${index}.jsonl`, {
        id: `session-${index}`,
        cwd: "/tmp/many",
      })
    )
  );

  const listed = await registry.list();
  expect(new Set(listed.map((summary) => summary.sessionId)).size).toBe(count);
  expect(
    listed.every(
      (summary, index) =>
        index === 0 || summary.modifiedAt <= listed[index - 1]!.modifiedAt
    )
  ).toBe(true);
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
  const host = await registry.create({ cwd: tmp });

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

test("opens a session whose file is not named after it", async () => {
  // The id is the header's. Pi's own filenames carry it, and the id a file
  // was written under is the one the header says either way.
  const path = await seed("--tmp-odd--", "notes.jsonl", {
    id: "renamed-file",
    cwd: "/tmp/odd",
  });

  const host = await registry.open("renamed-file");
  expect(host.settings.sessionPath).toBe(path);
  expect(host.cwd).toBe("/tmp/odd");
});

test("requires init before building a host", async () => {
  const fresh = new SessionRegistry({ defaults: { cwd: tmp }, agentDir });
  expect(fresh.create()).rejects.toThrow(
    "AgentRuntime.init() must complete before use"
  );
});

async function seedFixture(): Promise<string> {
  return await seed(
    "--home-htpc-Desktop-dev-mmorpg--",
    `2026-08-01T10-17-46-728Z_${FIXTURE_ID}.jsonl`
  );
}

async function lineCount(path: string): Promise<number> {
  return (await new EventLog(path).read()).length;
}

test("renames a closed session with one appended line pi can read back", async () => {
  const path = await seedFixture();
  const before = await lineCount(path);

  expect(await registry.setName(FIXTURE_ID, "Sidebar rename")).toBe(
    "Sidebar rename"
  );

  expect(await lineCount(path)).toBe(before + 1);
  expect(await new EventLog(path).name()).toBe("Sidebar rename");
  expect((await new EventLog(path).digest()).title).toBe("Sidebar rename");
  expect(await Bun.file(SessionLease.pathFor(path)).exists()).toBe(false);
});

test("clearing a name falls the row back to the opening message", async () => {
  const path = await seedFixture();
  await registry.setName(FIXTURE_ID, "Sidebar rename");

  expect(await registry.setName(FIXTURE_ID, null)).toBeUndefined();

  expect(await new EventLog(path).name()).toBeUndefined();
  expect((await new EventLog(path).digest()).named).toBeUndefined();
});

test("normalises a name pi would have stored verbatim", async () => {
  const path = await seedFixture();

  expect(
    await registry.setName(FIXTURE_ID, " two\nlines\tand\u0007a bell  ")
  ).toBe("two lines and a bell");
  expect(await registry.setName(FIXTURE_ID, "n".repeat(500))).toBe(
    "n".repeat(80)
  );
  expect(await registry.setName(FIXTURE_ID, "🙂".repeat(500))).toBe(
    "🙂".repeat(80)
  );
  expect(await registry.setName(FIXTURE_ID, "   ")).toBeUndefined();
  expect(await new EventLog(path).name()).toBeUndefined();
});

test("refuses to rename a session that is not on disk", async () => {
  expect(registry.setName("nope", "whatever")).rejects.toThrow(
    "unknown session: nope"
  );
});

test("renames a live session through the agent that holds it", async () => {
  const host = await registry.create({ cwd: tmp });
  const sessionId = host.sessionId!;
  const seen: string[] = [];
  host.subscribe((event) => {
    seen.push(event.type);
  });

  expect(await registry.setName(sessionId, "Live rename")).toBe("Live rename");

  expect(host.agentSession?.sessionManager.getSessionName()).toBe(
    "Live rename"
  );
  expect(seen).toContain("session_info_changed");
});

test("refuses to rename under another surface's turn", async () => {
  const path = await seedFixture();
  await Bun.write(
    SessionLease.pathFor(path),
    `${JSON.stringify({
      pid: process.pid,
      hostname: "another-host",
      frontend: "tui",
      startedAt: Date.now(),
    })}\n`
  );

  expect(registry.setName(FIXTURE_ID, "Sidebar rename")).rejects.toThrow(
    "Session is busy: tui"
  );
  expect(await new EventLog(path).name()).toBeUndefined();
});
