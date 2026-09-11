import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { SessionLease } from "#core/session/SessionLease";
import registerSessionLease from "./index";

type Notification = { readonly message: string; readonly level: string };
type Handler = (event: never, ctx: never) => unknown;

type Harness = {
  readonly notifications: readonly Notification[];
  readonly sent: readonly string[];
  readonly switched: readonly string[];
  aborts(): number;
  setIdle(next: boolean): void;
  setSession(file: string | undefined, entryCount?: number): void;
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

/** Header on line 1, so `entryCount` durable entries put the head at `entryCount + 1`. */
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

async function holdForeignLease(path: string): Promise<void> {
  await Bun.write(SessionLease.pathFor(path), `${JSON.stringify(FOREIGN)}\n`);
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(): Harness {
  let sessionFile: string | undefined;
  let entries: unknown[] = [];
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
      getEntries: () => entries,
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

  registerSessionLease(api);

  const harness: Harness = {
    notifications,
    sent,
    switched,
    aborts: () => aborts,
    setIdle(next: boolean): void {
      idle = next;
    },
    setSession(file: string | undefined, entryCount = 0): void {
      sessionFile = file;
      entries = Array.from({ length: entryCount }, (_, i) => i);
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

/** A harness bound to a session file whose entries pi already has in memory. */
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
  const { harness, path } = await started("self-write", 2);

  await appendEntries(path, 1);
  harness.setSession(path, 3);

  await expect(harness.input("hello")).resolves.toEqual({ action: "continue" });
  expect(harness.notifications).toEqual([]);
});

// pi names the file at session_start and buffers entries until the first assistant reply,
// so the whole of that first write — header included — is ours.
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
