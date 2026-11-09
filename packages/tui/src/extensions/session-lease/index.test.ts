import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { appendFile, mkdtemp, rm, utimes } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { SessionLease } from "#core/session/SessionLease";
import { until } from "#core/shared/fixtures/wait";
import sessionLease from "./index";
import { SessionGate } from "./SessionGate";

type Notification = { readonly message: string; readonly level: string };
type Handler = (event: never, ctx: never) => unknown;

type Harness = {
  readonly gate: SessionGate;
  readonly notifications: readonly Notification[];
  readonly sent: readonly string[];
  readonly switched: readonly string[];
  aborts(): number;
  setIdle(next: boolean): void;
  setSession(file: string | undefined, entryCount?: number): void;
  /** Appends the way pi does: into memory, then synchronously onto the file. */
  append(index: number): void;
  /** Has pi append `count` entries just before the extension next reads pi's memory. */
  appendBeforeNextRead(count: number): void;
  emit(event: string, payload?: object): Promise<unknown>;
  input(text: string): Promise<InputEventResult>;
  run(name: string, args?: string): Promise<void>;
};

const FOREIGN = {
  pid: 999_999,
  hostname: "another-host",
  frontend: "daemon",
  startedAt: Date.now(),
};

let tmp: string;
let harnesses: Harness[] = [];

function entryLine(index: number): string {
  return `${JSON.stringify({ type: "message", id: `e${index}` })}\n`;
}

async function writeSession(path: string, entryCount: number): Promise<void> {
  const header = `${JSON.stringify({ type: "session", id: "s", version: 8 })}\n`;
  const entries = Array.from({ length: entryCount }, (_, i) => entryLine(i));
  await Bun.write(path, [header, ...entries].join(""));
}

async function appendEntries(path: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await appendFile(path, entryLine(1_000 + i));
  }
}

async function appendName(path: string, name: string): Promise<void> {
  await appendFile(
    path,
    `${JSON.stringify({ type: "session_info", id: "renamed", name })}\n`
  );
}

async function holdForeignLease(path: string): Promise<void> {
  await Bun.write(SessionLease.pathFor(path), `${JSON.stringify(FOREIGN)}\n`);
}

/** A lease `acquire` would steal: its process on this host is gone, or it stopped heartbeating. */
async function holdAbandonedLease(
  path: string,
  how: "dead" | "silent"
): Promise<void> {
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  const pid = how === "dead" ? exited.pid : process.ppid;
  const lease = SessionLease.pathFor(path);
  await Bun.write(
    lease,
    `${JSON.stringify({ ...FOREIGN, pid, hostname: hostname() })}\n`
  );
  if (how === "silent") {
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(lease, longAgo, longAgo);
  }
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(): Harness {
  let sessionFile: string | undefined;
  let ids: string[] = [];
  let beforeRead: (() => void) | undefined;
  let idle = true;
  let aborts = 0;
  const notifications: Notification[] = [];
  const sent: string[] = [];
  const switched: string[] = [];

  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string, level = "info"): void {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getEntries: () => known().map((id) => ({ id })),
      getEntry: (id: string) => (known().includes(id) ? { id } : undefined),
    },
    isIdle: () => idle,
    abort(): void {
      aborts += 1;
    },
    async switchSession(path: string): Promise<{ cancelled: boolean }> {
      switched.push(path);
      return { cancelled: false };
    },
  };

  function known(): readonly string[] {
    const hook = beforeRead;
    beforeRead = undefined;
    hook?.();
    return ids;
  }

  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: never) => unknown>();
  const api = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: never) => unknown }
    ): void {
      commands.set(name, options.handler);
    },
    sendUserMessage(text: string): void {
      sent.push(text);
    },
  } as unknown as ExtensionAPI;

  const gate = new SessionGate();
  sessionLease({ gate })(api);

  const harness: Harness = {
    gate,
    notifications,
    sent,
    switched,
    aborts: () => aborts,
    setIdle(next: boolean): void {
      idle = next;
    },
    setSession(file: string | undefined, entryCount = 0): void {
      sessionFile = file;
      ids = Array.from({ length: entryCount }, (_, i) => `e${i}`);
    },
    append(index: number): void {
      ids.push(`e${index}`);
      if (sessionFile !== undefined) {
        appendFileSync(sessionFile, entryLine(index));
      }
    },
    appendBeforeNextRead(count: number): void {
      beforeRead = () => {
        for (let i = 0; i < count; i++) {
          harness.append(ids.length);
        }
      };
    },
    async emit(event: string, payload: object = {}): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(
          { type: event, ...payload } as never,
          ctx as never
        );
      }
      return result;
    },
    async input(text: string): Promise<InputEventResult> {
      return (await harness.emit("input", {
        text,
        source: "interactive",
      })) as InputEventResult;
    },
    async run(name: string, args = ""): Promise<void> {
      await commands.get(name)?.(args, ctx as never);
    },
  };
  harnesses.push(harness);
  return harness;
}

async function started(
  name: string,
  entryCount: number
): Promise<{ readonly harness: Harness; readonly path: string }> {
  const path = join(tmp, `${name}.jsonl`);
  await writeSession(path, entryCount);
  const harness = createHarness();
  harness.setSession(path, entryCount);
  await harness.emit("session_start", { reason: "startup" });
  return { harness, path };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-session-lease-"));
});

afterEach(async () => {
  for (const harness of harnesses) {
    await harness.emit("session_shutdown");
  }
  harnesses = [];
  await rm(tmp, { recursive: true, force: true });
});

test("input is swallowed while another surface holds the lease", async () => {
  const { harness, path } = await started("held", 2);
  await holdForeignLease(path);

  const result = await harness.input("hello");

  expect(result).toEqual({ action: "handled" });
  expect(harness.notifications[0]?.message).toBe(
    "The browser is running a turn. Try again when it finishes."
  );
  expect(harness.sent).toEqual([]);
});

test("input passes when nothing has written the file", async () => {
  const { harness } = await started("fresh", 2);

  await expect(harness.input("hello")).resolves.toEqual({ action: "continue" });
  expect(harness.notifications).toEqual([]);
});

test("input is swallowed and auto-synced once another writer appends", async () => {
  const { harness, path } = await started("stale", 2);
  await appendEntries(path, 2);

  const result = await harness.input("hello");

  expect(result).toEqual({ action: "handled" });
  expect(harness.notifications[0]?.message).toContain("continued elsewhere");
  expect(harness.sent).toEqual([]);

  await nextMacrotask();

  expect(harness.sent).toEqual(["/sync"]);
});

test("an out-of-turn write from this terminal is not staleness", async () => {
  const { harness } = await started("self-write", 2);

  harness.append(2);

  await expect(harness.input("hello")).resolves.toEqual({ action: "continue" });
  expect(harness.notifications).toEqual([]);
});

test("results pi appends while the gate measures the file are not staleness", async () => {
  const { harness } = await started("racing-results", 2);

  harness.appendBeforeNextRead(2);
  await expect(harness.gate.check()).resolves.toBe("open");

  await expect(harness.input("hello")).resolves.toEqual({ action: "continue" });
  expect(harness.notifications).toEqual([]);
});

test("a rename from another surface is not staleness", async () => {
  const { harness, path } = await started("renamed", 2);

  await appendName(path, "named from the browser");

  await expect(harness.input("hello")).resolves.toEqual({ action: "continue" });
  expect(harness.notifications).toEqual([]);

  await appendEntries(path, 1);
  await expect(harness.input("hello")).resolves.toEqual({ action: "handled" });
});

test("a message beside the rename is still staleness", async () => {
  const { harness, path } = await started("renamed-and-said", 2);

  await appendName(path, "named from the browser");
  await appendEntries(path, 1);

  await expect(harness.input("hello")).resolves.toEqual({ action: "handled" });
  expect(harness.notifications[0]?.message).toContain("continued elsewhere");
});

// pi creates the file only on the first assistant reply.
test("a session file that only appears during the first turn is not staleness", async () => {
  const path = join(tmp, "unborn.jsonl");
  const harness = createHarness();
  harness.setSession(path, 2);
  await harness.emit("session_start", { reason: "new" });

  await expect(harness.input("hello")).resolves.toEqual({ action: "continue" });

  await writeSession(path, 4);
  harness.setSession(path, 4);
  await harness.emit("agent_settled");

  await expect(harness.input("hello")).resolves.toEqual({ action: "continue" });
  expect(harness.notifications).toEqual([]);
});

test("a foreign append into a file pi has not written yet is staleness", async () => {
  const path = join(tmp, "raced.jsonl");
  const harness = createHarness();
  harness.setSession(path, 2);
  await harness.emit("session_start", { reason: "new" });

  await writeSession(path, 5);
  harness.setSession(path, 4);
  await harness.emit("agent_settled");

  await expect(harness.input("hello")).resolves.toEqual({ action: "handled" });
});

test("a foreign append during our own turn is caught when it settles", async () => {
  const { harness, path } = await started("during", 2);

  await harness.emit("before_agent_start", { prompt: "hello" });
  await appendEntries(path, 1);
  await harness.emit("agent_settled");

  await expect(harness.input("hello")).resolves.toEqual({ action: "handled" });
});

test("the swallowed message comes back on the replacement instance", async () => {
  const { harness, path } = await started("carried", 2);
  await appendEntries(path, 2);
  await harness.input("the message I typed");
  await nextMacrotask();

  const replacement = createHarness();
  replacement.setSession(path, 4);
  await replacement.emit("session_start", { reason: "resume" });

  expect(replacement.notifications[0]?.message).toBe(
    "Caught up — your message was not sent: the message I typed"
  );
});

test("/sync switches to the current session path and gives the lease back", async () => {
  const { harness, path } = await started("sync", 2);
  await appendEntries(path, 2);

  await harness.run("sync");

  expect(harness.switched).toEqual([path]);
  expect(await Bun.file(SessionLease.pathFor(path)).exists()).toBe(false);
});

test("/sync leaves a foreign lease alone", async () => {
  const { harness, path } = await started("sync-held", 2);
  await holdForeignLease(path);

  await harness.run("sync");

  expect(harness.switched).toEqual([]);
  expect(harness.notifications[0]?.message).toContain(
    "Try /sync when it finishes"
  );
});

test("/sync waits for a turn of our own to finish", async () => {
  const { harness } = await started("sync-busy", 2);
  harness.setIdle(false);

  await harness.run("sync");

  expect(harness.switched).toEqual([]);
  expect(harness.notifications[0]?.message).toContain(
    "Wait for the current turn"
  );
});

test("a turn takes the lease and settling gives it back", async () => {
  const { harness, path } = await started("turn", 2);

  await harness.emit("before_agent_start", { prompt: "hello" });

  expect(await SessionLease.read(path)).toMatchObject({ pid: process.pid });

  await harness.emit("agent_settled");

  expect(await Bun.file(SessionLease.pathFor(path)).exists()).toBe(false);
});

test("settling again never unlinks a lease we do not hold", async () => {
  const { harness, path } = await started("idempotent", 2);
  await harness.emit("before_agent_start", { prompt: "hello" });
  await harness.emit("agent_settled");

  await holdForeignLease(path);
  await harness.emit("agent_settled");

  expect(await SessionLease.read(path)).toMatchObject({ pid: FOREIGN.pid });
});

test("losing the race at turn start aborts the turn", async () => {
  const { harness, path } = await started("race", 2);
  await holdForeignLease(path);

  await harness.emit("before_agent_start", { prompt: "hello" });

  expect(harness.aborts()).toBe(1);
  expect(harness.notifications[0]?.message).toContain("just started a turn");
});

test("a session switch re-points the gate at the new file", async () => {
  const { harness, path } = await started("first", 2);
  await holdForeignLease(path);

  const next = join(tmp, "second.jsonl");
  await writeSession(next, 2);
  harness.setSession(next, 2);
  await harness.emit("session_start", { reason: "resume" });

  await expect(harness.input("hello")).resolves.toEqual({ action: "continue" });

  await holdForeignLease(next);

  await expect(harness.input("hello")).resolves.toEqual({ action: "handled" });
});

test("the gate is open while nobody else has touched the session", async () => {
  const { harness } = await started("gate-open", 2);

  await expect(harness.gate.check()).resolves.toBe("open");
});

test("the gate is held while another surface runs a turn", async () => {
  const { harness, path } = await started("gate-held", 2);
  await holdForeignLease(path);

  await expect(harness.gate.check()).resolves.toBe("held");
  expect(harness.sent).toEqual([]);
});

test("a stale gate catches up once, however often it is asked", async () => {
  const { harness, path } = await started("gate-stale", 2);
  await appendEntries(path, 1);

  await expect(harness.gate.check()).resolves.toBe("stale");
  await expect(harness.gate.check()).resolves.toBe("stale");
  await nextMacrotask();

  expect(harness.sent).toEqual(["/sync"]);
  expect(harness.notifications[0]?.message).toContain("continued elsewhere");
});

test("a lease another surface is still writing holds the gate", async () => {
  const { harness, path } = await started("gate-torn", 2);
  await Bun.write(SessionLease.pathFor(path), '{"pid": 12');

  await expect(harness.gate.check()).resolves.toBe("held");
  await expect(harness.input("hello")).resolves.toEqual({ action: "handled" });
  expect(harness.notifications[0]?.message).toBe(
    "Another surface is running a turn. Try again when it finishes."
  );
});

test.each(["dead", "silent"] as const)(
  "a lease left by a %s process on this host holds nothing",
  async (how) => {
    const { harness, path } = await started(`abandoned-${how}`, 2);
    await holdAbandonedLease(path, how);

    await expect(harness.gate.check()).resolves.toBe("open");
    await expect(harness.input("hello")).resolves.toEqual({
      action: "continue",
    });
    await harness.run("sync");
    expect(harness.switched).toEqual([path]);
  }
);

test("a stale gate asked while the session closes does not catch up", async () => {
  const { harness, path } = await started("gate-closing", 2);
  await appendEntries(path, 1);

  await harness.emit("session_shutdown");
  await expect(harness.gate.check()).resolves.toBe("stale");
  await nextMacrotask();

  expect(harness.sent).toEqual([]);
  expect(harness.notifications).toEqual([]);
});

test("the gate reports a change when the lease file does", async () => {
  const { harness, path } = await started("gate-change", 2);
  let changes = 0;
  harness.gate.onChange(() => {
    changes += 1;
  });

  await holdForeignLease(path);

  await until(() => changes > 0, "the gate to report the new lease");
  await expect(harness.gate.check()).resolves.toBe("held");
});
