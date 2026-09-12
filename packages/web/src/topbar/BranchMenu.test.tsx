import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { GatewayHarness, until } from "../test/gateway";
import { Topbar } from "./Topbar";

/**
 * The branch chip against a real gateway and a real repository: the rows are
 * what `git for-each-ref` says about a repository this test built, and
 * choosing one runs the checkout.
 */

let harness: GatewayHarness;
let store: SessionStore;
let dispose: (() => void) | undefined;

beforeEach(async () => {
  localStorage.clear();
  harness = new GatewayHarness();
  await harness.start();
  await makeRepo(harness.tmp, ["feat/work"]);
  store = new SessionStore({
    url: harness.url,
    cwd: harness.tmp,
    pickerDebounceMs: 0,
  });
  await store.connect();
  await until(() => store.state.branch !== undefined, "the branch to land");
});

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  store.dispose();
  await harness.stop();
});

function paint(): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => (
      <Topbar
        store={store}
        compact={false}
        reviewing={false}
        onToggleSidebar={() => {}}
        onToggleDiff={() => {}}
      />
    ),
    host
  );
  flush();
  return host;
}

function chip(host: HTMLElement): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(
    '[aria-haspopup="listbox"]'
  );
  if (found === null) {
    throw new Error("the branch chip is not painted");
  }
  return found;
}

function rows(host: HTMLElement): readonly HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')];
}

function names(host: HTMLElement): readonly (string | null | undefined)[] {
  return rows(host).map((row) => row.querySelector("span")?.textContent);
}

function expanded(host: HTMLElement): boolean {
  return chip(host).getAttribute("aria-expanded") === "true";
}

function action(host: HTMLElement, title: string): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(`[title="${title}"]`);
  if (found === null) {
    throw new Error(`no ${title} button`);
  }
  return found;
}

/**
 * The two notices read the same, so only their tone tells them apart: amber is
 * the standing banner, rose is what the last press answered.
 */
function notice(host: HTMLElement, tone: "amber" | "rose"): string {
  return host.querySelector(`p.text-${tone}-400`)?.textContent ?? "";
}

async function open(): Promise<HTMLElement> {
  const host = paint();
  chip(host).click();
  flush();
  await until(() => {
    flush();
    return rows(host).length > 0;
  }, "the branch list");
  return host;
}

test("lists the trunk first and marks where the session stands", async () => {
  const host = await open();

  expect(names(host)).toEqual(["main", "feat/work"]);
  expect(rows(host)[1]?.getAttribute("aria-selected")).toBe("false");
  // The check is on the branch in force, which is the one navigation starts on.
  expect(
    rows(host)[1]?.querySelector(".i-griddy-icons\\:check")
  ).not.toBeNull();
});

test("a branch nothing has been committed to in a month is left off", async () => {
  const when = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  await git(harness.tmp, ["checkout", "-b", "feat/last-winter"]);
  await git(harness.tmp, ["commit", "--allow-empty", "-m", "old"], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
  await git(harness.tmp, ["checkout", "feat/work"]);

  const host = await open();

  expect(names(host)).toEqual(["main", "feat/work"]);
});

test("choosing a branch checks it out and the chip follows", async () => {
  const host = await open();

  rows(host)[0]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

  await until(() => store.state.branch === "main", "the checkout");
  flush();
  expect(chip(host).textContent).toContain("main");
  // The menu is done once the branch moved; the list behind it is stale.
  expect(expanded(host)).toBe(false);
});

test("git's refusal is shown where the button was pressed", async () => {
  const host = await open();

  action(host, "Publish this branch").click();

  await until(() => {
    flush();
    return host.textContent?.includes("no remote") === true;
  }, "the push failure");
  // Still open: the reader has to be able to read why.
  expect(expanded(host)).toBe(true);
});

test("a working agent freezes the menu, and says why", async () => {
  const host = await open();
  store.ingest({
    type: "session_state",
    writable: true,
    repoBusy: true,
    cwd: harness.tmp,
    model: "test/echo",
    thinking: "off",
    cost: 0,
    status: "thinking",
    branch: "feat/work",
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
  });
  flush();

  expect(action(host, "Fast-forward from the remote").disabled).toBe(true);
  expect(notice(host, "amber")).toContain("an agent is still working");

  rows(host)[0]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  flush();

  expect(store.state.branch).toBe("feat/work");
  expect(notice(host, "rose")).toContain("an agent is still working");
});
