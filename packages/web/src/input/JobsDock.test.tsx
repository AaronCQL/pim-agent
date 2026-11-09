import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { flush } from "solid-js";

import type { ServerEvent } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { job, jobs } from "../test/jobs";
import { JobsDock } from "./JobsDock";

type Command = { readonly type: string } & Record<string, unknown>;

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

function attached(): ServerEvent {
  return {
    type: "attached",
    sessionId: "s1",
    cwd: "/repo",
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  };
}

function connected(): { store: SessionStore; sent: Command[] } {
  const store = new SessionStore({
    url: "ws://127.0.0.1:1",
    pickerDebounceMs: 0,
  });
  const sent: Command[] = [];
  store.client.send = (async (command: Command) => {
    sent.push(command);
    return { type: "response", id: "1", success: true };
  }) as typeof store.client.send;
  store.ingest(attached());
  return { store, sent };
}

function feed(store: SessionStore, ...events: readonly ServerEvent[]): void {
  for (const event of events) {
    store.ingest(event);
  }
  flush();
}

function paint(store: SessionStore): HTMLElement {
  const host = mountPoint();
  render(() => <JobsDock store={store} />, host);
  flush();
  return host;
}

function dock(host: HTMLElement): HTMLElement | null {
  return host.querySelector("section[aria-label='Background subagents']");
}

function rows(host: HTMLElement): readonly HTMLButtonElement[] {
  return [
    ...host.querySelectorAll<HTMLButtonElement>("li > button[aria-haspopup]"),
  ];
}

function summary(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector("button[aria-expanded]");
}

test("nothing is docked, and no clock ticks, while no job runs", () => {
  jest.useFakeTimers();
  const { store } = connected();
  const host = paint(store);

  expect(dock(host)).toBeNull();
  expect(jest.getTimerCount()).toBe(0);

  feed(store, jobs(job("a")));
  expect(dock(host)).not.toBeNull();
  expect(jest.getTimerCount()).toBe(1);

  feed(store, jobs());
  expect(dock(host)).toBeNull();
  expect(jest.getTimerCount()).toBe(0);
});

test("a row reads the job's handle, its turns, cost and context, and how long it has run, on one line", () => {
  jest.useFakeTimers();
  setSystemTime(new Date(65_000));
  const { store } = connected();
  feed(
    store,
    jobs(
      job("a", {
        startedAt: 2_000,
        turns: 4,
        cost: 0.123,
        contextTokens: 50_000,
        contextWindow: 1_000_000,
      }),
      job("b", { handle: "j2", startedAt: 60_000 })
    )
  );
  const host = paint(store);

  expect(rows(host).map((row) => row.textContent)).toEqual([
    "j1:4 turns ⬝ $0.12 ⬝ 5.0%/1.0M1m 3s",
    "j2:1 turn ⬝ $0.005s",
  ]);
  expect(rows(host)[0]!.hasAttribute("title")).toBe(false);
});

test("a job its context notice was issued for is marked next to its context", () => {
  jest.useFakeTimers();
  setSystemTime(new Date(5_000));
  const { store } = connected();
  feed(
    store,
    jobs(
      job("a", {
        contextTokens: 410_000,
        contextWindow: 1_000_000,
        noticed: true,
      })
    )
  );
  const host = paint(store);

  expect(rows(host).map((row) => row.textContent)).toEqual([
    "j1:1 turn ⬝ $0.00 ⬝ ⚠ 41.0%/1.0M5s",
  ]);
});

test("the elapsed time follows the clock, not the next list", () => {
  jest.useFakeTimers();
  setSystemTime(new Date(10_000));
  const { store } = connected();
  feed(store, jobs(job("a", { startedAt: 1_000 })));
  const host = paint(store);
  const elapsed = (): string | null =>
    rows(host)[0]!.querySelector(".tabular-nums")!.textContent;
  expect(elapsed()).toBe("9s");

  jest.advanceTimersByTime(61_000);
  flush();
  expect(elapsed()).toBe("1m 10s");
});

test("a server clock ahead of this one reads zero, not a negative time", () => {
  jest.useFakeTimers();
  setSystemTime(new Date(1_000));
  const { store } = connected();
  feed(store, jobs(job("a", { startedAt: 4_000 })));
  const host = paint(store);

  expect(rows(host)[0]!.querySelector(".tabular-nums")!.textContent).toBe("0s");
});

test("clicking a row watches that job's log", async () => {
  const { store, sent } = connected();
  feed(store, jobs(job("call_a"), job("call_b")));
  const host = paint(store);

  rows(host)[1]!.click();
  await Promise.resolve();
  flush();

  expect(store.state.subagent?.callId).toBe("call_b");
  expect(sent).toEqual([
    { type: "watch_subagent", sessionId: "s1", callId: "call_b", fromSeq: 0 },
  ]);
});

test("more than three jobs fold behind one line that opens onto them all", () => {
  jest.useFakeTimers();
  setSystemTime(new Date(30_000));
  const { store } = connected();
  feed(
    store,
    jobs(
      job("a"),
      job("b", { startedAt: 20_000 }),
      job("c", { startedAt: 25_000 })
    )
  );
  const host = paint(store);
  expect(summary(host)).toBeNull();
  expect(rows(host)).toHaveLength(3);

  feed(
    store,
    jobs(
      job("a"),
      job("b", { startedAt: 20_000 }),
      job("c", { startedAt: 25_000 }),
      job("d", { startedAt: 29_000 })
    )
  );
  expect(rows(host)).toHaveLength(0);
  expect(summary(host)!.textContent).toBe("4 subagents running30s");
  expect(summary(host)!.getAttribute("aria-expanded")).toBe("false");

  summary(host)!.click();
  flush();
  expect(summary(host)!.getAttribute("aria-expanded")).toBe("true");
  expect(rows(host)).toHaveLength(4);

  summary(host)!.click();
  flush();
  expect(rows(host)).toHaveLength(0);

  feed(store, jobs(job("d")));
  expect(summary(host)).toBeNull();
  expect(rows(host)).toHaveLength(1);
});

test("switching session takes the other session's jobs off the dock", () => {
  const { store } = connected();
  feed(store, jobs(job("a")));
  const host = paint(store);
  expect(rows(host)).toHaveLength(1);

  feed(store, { ...attached(), sessionId: "s2" } as ServerEvent);
  expect(dock(host)).toBeNull();
});
