import "../test/dom";

import { render } from "@solidjs/web";
import { expect, jest, setSystemTime, test } from "bun:test";
import { flush } from "solid-js";

import type { SessionSummaryView } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { Sidebar } from "./Sidebar";

const SESSIONS: readonly SessionSummaryView[] = [
  {
    sessionId: "aaaaaaaa-1111",
    cwd: "/home/ada/dev/pim",
    createdAt: 0,
    modifiedAt: 0,
    title: "Modernise the string building",
    head: 12,
  },
  {
    sessionId: "bbbbbbbb-2222",
    cwd: "/srv/other",
    createdAt: 0,
    modifiedAt: 0,
    head: 0,
  },
];

/** Offline: `listSessions` is stubbed, which is the only thing this reads. */
function paint(
  onNavigate?: () => void,
  seen?: Record<string, number>
): {
  readonly host: HTMLElement;
  readonly switched: string[];
} {
  // The read cursor is this browser's, so it is seeded where it lives.
  localStorage.setItem("pim.seen", JSON.stringify(seen ?? {}));
  const store = new SessionStore({ url: "ws://127.0.0.1:1" });
  const switched: string[] = [];
  store.listSessions = async () => SESSIONS;
  store.switchTo = async (sessionId) => {
    switched.push(sessionId);
  };
  const host = mountPoint();
  render(
    () => <Sidebar store={store} {...(onNavigate ? { onNavigate } : {})} />,
    host
  );
  flush();
  return { host, switched };
}

test("one flat row per session: name, cwd and how long ago", async () => {
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Modernise the string building");
  // A session with nothing written to it yet has only its id for a name.
  expect(rows[1]?.textContent).toContain("bbbbbbbb");
  expect(rows[0]?.textContent).toContain("~/dev/pim");
  expect(rows[1]?.textContent).toContain("/srv/other");
});

test("the dot marks a session written past what this browser has painted", async () => {
  const { host } = paint(undefined, { "aaaaaaaa-1111": 12 });
  await Bun.sleep(0);
  flush();

  const dots = [...host.querySelectorAll('[aria-label="Unread"]')];
  // The first session is read up to its head; the second was never opened and
  // has nothing on disk either, so neither is unread.
  expect(dots).toHaveLength(0);

  const { host: stale } = paint(undefined, { "aaaaaaaa-1111": 4 });
  await Bun.sleep(0);
  flush();
  expect(
    stale.querySelectorAll('li:first-child [aria-label="Unread"]')
  ).toHaveLength(1);
});

test("picking a row attaches to it and tells the host to get out of the way", async () => {
  const navigated: number[] = [];
  const { host, switched } = paint(() => navigated.push(1));
  await Bun.sleep(0);
  flush();

  host
    .querySelectorAll("li button")[1]!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(switched).toEqual(["bbbbbbbb-2222"]);
  expect(navigated).toEqual([1]);
});

test("a row's age follows the clock, not the next render", async () => {
  // The row's clock is a `setInterval`, so it has to be the fake one by the
  // time the component mounts. This resets the wall clock, hence the order.
  jest.useFakeTimers();
  // The fixture's sessions were last written at the epoch, so the mocked
  // wall clock *is* the age.
  setSystemTime(new Date(30_000));
  const { host } = paint();
  // Not `Bun.sleep`: under fake timers nothing advances the clock but this
  // test, and the stubbed `listSessions` only needs its microtask drained.
  await Promise.resolve();
  flush();
  const age = (): string | undefined =>
    host.querySelector("li button > div:last-child > div:last-child")
      ?.textContent ?? undefined;
  expect(age()).toBe("30s");

  setSystemTime(new Date(90_000));
  // Nothing here re-renders the list; only the component's own tick does.
  jest.advanceTimersByTime(1000);
  flush();
  expect(age()).toBe("1m");
  jest.useRealTimers();
  setSystemTime();
});

test("the server row names the host and tints itself with the connection", () => {
  const { host } = paint();

  expect(host.textContent).toContain("127.0.0.1:1");
  expect(host.innerHTML).toContain("text-rose-400");
});
