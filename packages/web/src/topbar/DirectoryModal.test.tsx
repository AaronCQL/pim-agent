import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { flush } from "solid-js";

import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { GatewayHarness, until } from "../test/gateway";
import { Topbar } from "./Topbar";

/**
 * Choosing where to work, against the real gateway and a real filesystem: the
 * rows are `list_dirs` answers about a temporary directory this test made,
 * and opening one runs the whole `attach` that starts a session in it.
 */

let harness: GatewayHarness;
let store: SessionStore;
let dispose: (() => void) | undefined;
let alpha: string;
let beta: string;

beforeEach(async () => {
  localStorage.clear();
  harness = new GatewayHarness();
  await harness.start();
  alpha = join(harness.tmp, "alpha");
  beta = join(harness.tmp, "beta");
  await mkdir(join(alpha, "inner"), { recursive: true });
  await mkdir(beta, { recursive: true });
  await mkdir(join(harness.tmp, ".hidden"), { recursive: true });
  store = new SessionStore({
    url: harness.url,
    cwd: harness.tmp,
    pickerDebounceMs: 0,
  });
  await store.connect();
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

/** The chip that is the one way in, opened onto a listing that has landed. */
async function open(): Promise<HTMLElement> {
  const host = paint();
  chip(host).click();
  flush();
  // The footer names the directory being browsed, and can only name it once
  // the server has said it is one.
  await settle(() => footer(host).disabled === false, "the directory listing");
  return host;
}

function chip(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    '[aria-label^="Working directory"]'
  )!;
}

function rows(host: HTMLElement): readonly HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')];
}

function labels(host: HTMLElement): readonly string[] {
  return rows(host).map((row) => row.textContent?.replace("recent", "") ?? "");
}

/** The first row that is a directory this machine already has sessions in. */
function recentRow(host: HTMLElement): HTMLElement | undefined {
  return rows(host).find((row) => row.textContent?.includes("recent"));
}

function box(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('[aria-label="Directory path"]')!;
}

function footer(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    '[title="Start a new session in this directory"]'
  )!;
}

function type(host: HTMLElement, text: string): void {
  const input = box(host);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

/** Polls a reactive answer: the listing arrives over the socket. */
function settle(test: () => boolean, label: string): Promise<void> {
  return until(() => {
    flush();
    return test();
  }, label);
}

test("the chip opens on the current directory, hiding what starts with a dot", async () => {
  const host = await open();

  expect(box(host).value).toBe(`${harness.tmp}/`);
  // Focused with the path selected, so typing another one replaces it.
  expect(document.activeElement).toBe(box(host));
  expect(box(host).selectionEnd).toBe(box(host).value.length);
  expect(labels(host)).toContain("alpha");
  expect(labels(host)).toContain("beta");
  expect(labels(host)).not.toContain(".hidden");
  // Somewhere to go from the first frame: the directory already open is a
  // destination too, because a second session in it is a normal thing to ask
  // for.
  expect(footer(host).disabled).toBe(false);
  expect(host.textContent).toContain(harness.tmp);
});

test("a dot is how the hidden directories are asked for", async () => {
  const host = await open();

  type(host, `${harness.tmp}/.hid`);

  expect(labels(host)).toEqual([".hidden"]);
  // The typed path is not a directory, so the row under the cursor is what
  // the footer would open — and it says so.
  expect(footer(host).disabled).toBe(false);
  expect(host.textContent).toContain(join(harness.tmp, ".hidden"));
});

test("clicking a directory steps into it rather than opening it", async () => {
  const host = await open();

  rows(host)
    .find((row) => row.textContent?.startsWith("alpha"))!
    .click();
  flush();
  await settle(() => labels(host).includes("inner"), "alpha's contents");

  // Stepped in: the box moved, the session did not.
  expect(box(host).value).toBe(`${alpha}/`);
  expect(store.state.cwd).toBe(harness.tmp);
  // And now there is somewhere to open, named in full.
  expect(footer(host).disabled).toBe(false);
  expect(host.textContent).toContain(alpha);
});

test("the footer opens a new session in the directory browsed to", async () => {
  const host = await open();
  const first = store.state.sessionId;

  type(host, `${beta}/`);
  await settle(() => footer(host).disabled === false, "somewhere to open");
  footer(host).click();
  await settle(() => store.state.cwd === beta, "the new session's directory");

  expect(store.state.sessionId).not.toBe(first);
  expect(store.state.durable).toEqual([]);
  expect(host.querySelector("dialog")?.open).toBe(false);
});

test("the footer opens a second session in the directory already open", async () => {
  // Written to, so the session about to be left is one worth counting.
  await store.prompt("hello");
  await settle(
    () => !store.isBusy() && store.state.durable.length > 0,
    "the first turn"
  );
  const first = store.state.sessionId;
  const host = await open();

  footer(host).click();
  await settle(
    () => store.state.sessionId !== first,
    "the second session in the same directory"
  );

  expect(store.state.cwd).toBe(harness.tmp);
  expect(store.state.durable).toEqual([]);
  expect(host.querySelector("dialog")?.open).toBe(false);
});

test("a directory already worked in is one click, not a walk to it", async () => {
  // A session has to have been written for the listing to know its directory.
  await store.prompt("hello");
  await settle(
    () => !store.isBusy() && store.state.durable.length > 0,
    "the first turn"
  );
  await store.openDirectory(beta);
  await settle(() => store.state.cwd === beta, "the second session");
  const left = store.state.sessionId;

  const host = await open();
  // The recent directories are a second question, asked over the same socket
  // as the listing and answered on their own schedule.
  await settle(() => recentRow(host) !== undefined, "the recent directories");
  expect(recentRow(host)!.textContent).toContain(harness.tmp);
  // Not while a path is being completed, though: a recent directory that
  // happened to contain those letters would outrank the completion under the
  // cursor, and be what the footer opened.
  type(host, `${beta}/al`);
  expect(recentRow(host)).toBeUndefined();
  type(host, `${beta}/`);

  // Re-read: the rows either side of that are different elements.
  recentRow(host)!.click();
  await settle(
    () => store.state.cwd === harness.tmp,
    "the session opened from a recent directory"
  );
  // A recent directory is a destination: one click opens it, where a
  // subdirectory would have been stepped into.
  expect(store.state.sessionId).not.toBe(left);
});

test("reopening never offers the directory last browsed to", async () => {
  const host = await open();

  rows(host)
    .find((row) => row.textContent?.startsWith("alpha"))!
    .click();
  await settle(() => labels(host).includes("inner"), "alpha's contents");
  host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
  flush();
  chip(host).click();
  flush();

  // Before the new listing lands there is nothing to open: the last answer
  // was about somewhere else, and a modal that offered it would open a
  // session in a directory the reader had already left.
  expect(host.textContent).toContain("Nowhere to open");
  expect(footer(host).disabled).toBe(true);
  await settle(() => footer(host).disabled === false, "the current directory");
  expect(host.textContent).toContain(harness.tmp);
});
