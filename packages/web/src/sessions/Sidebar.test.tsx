import "../test/dom";

import { render } from "@solidjs/web";
import { expect, test } from "bun:test";
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
  },
  {
    sessionId: "bbbbbbbb-2222",
    cwd: "/srv/other",
    createdAt: 0,
    modifiedAt: 0,
  },
];

/** Offline: `listSessions` is stubbed, which is the only thing this reads. */
function paint(onNavigate?: () => void): {
  readonly host: HTMLElement;
  readonly switched: string[];
} {
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
  // Until Phase B carries a title, the id is the only name a session has.
  expect(rows[0]?.textContent).toContain("aaaaaaaa");
  expect(rows[0]?.textContent).toContain("~/dev/pim");
  expect(rows[1]?.textContent).toContain("/srv/other");
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

test("the server row names the host and tints itself with the connection", () => {
  const { host } = paint();

  expect(host.textContent).toContain("127.0.0.1:1");
  expect(host.innerHTML).toContain("text-rose-400");
});
