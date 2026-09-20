import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { flush } from "solid-js";

import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { GatewayHarness } from "../test/gateway";
import { until } from "#core/shared/fixtures/wait";
import { Topbar } from "./Topbar";

/**
 * Choosing where to work, against the real gateway and a real filesystem: the
 * rows are `list_dirs` answers about a temporary directory this test made,
 * the row that makes one runs the real `create_dir`, and opening runs the
 * whole `attach` that starts a session in it.
 */

let harness: GatewayHarness;
let store: SessionStore;
let dispose: (() => void) | undefined;
let alpha: string;
let beta: string;
let workshop: string;

beforeEach(async () => {
  localStorage.clear();
  harness = new GatewayHarness();
  await harness.start();
  alpha = join(harness.tmp, "alpha");
  beta = join(harness.tmp, "beta");
  workshop = join(harness.tmp, "workshop");
  await mkdir(join(alpha, "inner"), { recursive: true });
  await mkdir(beta, { recursive: true });
  await mkdir(join(harness.tmp, ".hidden"), { recursive: true });
  // A pair sharing a prefix, the second one deep: enough rows inside it that a
  // caret left on the index it held outside would point somewhere arbitrary.
  await mkdir(join(harness.tmp, "work"), { recursive: true });
  for (const name of ["four", "one", "three", "two"]) {
    await mkdir(join(workshop, name), { recursive: true });
  }
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
  // The button opens the directory being browsed, and can only offer to once
  // the server has said it is one.
  await settle(() => action(host).disabled === false, "the directory listing");
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
  return rows(host).map((row) => row.textContent ?? "");
}

function box(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('[aria-label="Directory path"]')!;
}

function panel(host: HTMLElement): HTMLDialogElement {
  return host.querySelector("dialog")!;
}

/** The one way up, whose shortcut is the same walk. */
function parent(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    '[aria-label="Parent directory"]'
  )!;
}

/** The one verb the modal has: open a session in whatever the box names. */
function action(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    '[aria-label="Start a new session in this directory"]'
  )!;
}

function type(host: HTMLElement, text: string): void {
  const input = box(host);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

type Chord = {
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
};

/** A key aimed at one element, as the browser aims it at whatever holds focus. */
function send(element: Element, key: string, chord: Chord = {}): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { key, ...chord, bubbles: true })
  );
  flush();
}

function press(host: HTMLElement, key: string, chord: Chord = {}): void {
  send(box(host), key, chord);
}

/** The row under the caret, which the arrows move and Enter acts on. */
function selected(host: HTMLElement): string | undefined {
  return (
    rows(host).find((row) => row.getAttribute("aria-selected") === "true")
      ?.textContent ?? undefined
  );
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
  // Focused with the path selected, so typing another one replaces it. The
  // focus is the attribute's: a dialog runs its own focusing steps as it is
  // shown, and what they find instead is the close button in the header —
  // where the arrows below would be that button's rather than the list's.
  expect(box(host).hasAttribute("autofocus")).toBe(true);
  expect(box(host).selectionEnd).toBe(box(host).value.length);
  expect(labels(host)).toContain("alpha");
  expect(labels(host)).toContain("beta");
  expect(labels(host)).not.toContain(".hidden");
  // Somewhere to go from the first frame: the directory already open is a
  // destination too, because a second session in it is a normal thing to ask
  // for.
  expect(action(host).disabled).toBe(false);
});

test("a dot is how the hidden directories are asked for", async () => {
  const host = await open();

  type(host, `${harness.tmp}/.hid`);

  // Half a name is not a directory, and the button only ever opens what the
  // box names: a row under the caret is somewhere to walk to, not the answer,
  // and what was typed is still a folder that could be made.
  expect(labels(host)).toEqual([".hidden", "New folder “.hid”"]);
  expect(action(host).disabled).toBe(true);

  type(host, `${harness.tmp}/.hidden`);

  expect(labels(host)).toEqual([".hidden"]);
  expect(action(host).disabled).toBe(false);
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
  // And now the box names somewhere to open.
  expect(action(host).disabled).toBe(false);
});

test("the arrows light a row, Enter walks to it, and every new set of rows starts at the top", async () => {
  const host = await open();

  press(host, "ArrowDown");
  expect(selected(host)).toBe(labels(host)[1]);

  // What the box says is what the rows are, so a filter that re-ranks them
  // hands the caret back rather than leaving it on the index it held, which
  // now names a folder nobody pointed at.
  type(host, `${harness.tmp}/w`);
  expect(labels(host)).toEqual(["work", "workshop", "New folder “w”"]);
  expect(selected(host)).toBe("work");

  press(host, "ArrowDown");
  press(host, "Enter");
  await settle(() => labels(host).includes("four"), "workshop's contents");

  // Enter is the keyboard's click: it walks to the lit row, so the box moved
  // and the session did not — and the rows it moved to are a new list, whose
  // first row is the only one the caret may land on unasked.
  expect(box(host).value).toBe(`${workshop}/`);
  expect(store.state.cwd).toBe(harness.tmp);
  expect(selected(host)).toBe("four");
});

test("Ctrl+Enter opens what the box names, whichever row the caret rests on", async () => {
  const host = await open();
  const first = store.state.sessionId;

  type(host, `${workshop}/`);
  await settle(() => labels(host).includes("four"), "workshop's contents");
  press(host, "ArrowDown");
  expect(selected(host)).toBe("one");

  press(host, "Enter", { ctrlKey: true });
  await settle(
    () => store.state.cwd === workshop,
    "the new session's directory"
  );

  // The key is the button: both open the box, never the highlighted row.
  expect(store.state.sessionId).not.toBe(first);
  expect(host.querySelector("dialog")?.open).toBe(false);
});

test("the button opens a new session in the directory browsed to", async () => {
  const host = await open();
  const first = store.state.sessionId;

  type(host, `${beta}/`);
  await settle(() => action(host).disabled === false, "somewhere to open");
  action(host).click();
  await settle(() => store.state.cwd === beta, "the new session's directory");

  expect(store.state.sessionId).not.toBe(first);
  expect(store.state.durable).toEqual([]);
  expect(host.querySelector("dialog")?.open).toBe(false);
});

test("the button opens a second session in the directory already open", async () => {
  // Written to, so the session about to be left is one worth counting.
  await store.prompt("hello");
  await settle(
    () => !store.isBusy() && store.state.durable.length > 0,
    "the first turn"
  );
  const first = store.state.sessionId;
  const host = await open();

  action(host).click();
  await settle(
    () => store.state.sessionId !== first,
    "the second session in the same directory"
  );

  expect(store.state.cwd).toBe(harness.tmp);
  expect(store.state.durable).toEqual([]);
  expect(host.querySelector("dialog")?.open).toBe(false);
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
  expect(action(host).disabled).toBe(true);
  await settle(() => action(host).disabled === false, "the current directory");
  expect(box(host).value).toBe(`${harness.tmp}/`);
});

test("a name nothing answers to is offered as a folder to make", async () => {
  const host = await open();

  type(host, `${harness.tmp}/gamma`);

  // Nothing by that name is there, so the last row is the way to make it and
  // the button has nothing to open yet.
  expect(labels(host)).toEqual(["New folder “gamma”"]);
  expect(action(host).disabled).toBe(true);

  rows(host).at(-1)!.click();
  await settle(
    () => box(host).value === `${join(harness.tmp, "gamma")}/`,
    "the new directory"
  );

  // Made on the server's disk, and stepped into like any other row: the box
  // now names a real directory, so the button lights by itself.
  expect((await stat(join(harness.tmp, "gamma"))).isDirectory()).toBe(true);
  await settle(() => action(host).disabled === false, "somewhere to open");
  expect(store.state.cwd).toBe(harness.tmp);
});

test("a name that is already a directory is walked to, never made", async () => {
  const host = await open();

  type(host, `${harness.tmp}/alpha`);

  // Exactly one of the two is ever true: the button opens what the box names,
  // or the list offers to make it.
  expect(labels(host)).toEqual(["alpha"]);
  expect(action(host).disabled).toBe(false);
});

test("a folder that cannot be made says why, where the listing would", async () => {
  // A file is not a place to work, so it is never listed — and the name it
  // holds is still taken.
  await Bun.write(join(harness.tmp, "notes.md"), "# hi\n");
  const host = await open();

  type(host, `${harness.tmp}/notes.md`);
  expect(labels(host)).toEqual(["New folder “notes.md”"]);

  rows(host).at(-1)!.click();
  await settle(
    () => (host.textContent ?? "").includes("already exists"),
    "the refusal"
  );
  // Refused, so the box stayed where it was rather than stepping into
  // somewhere that is not a directory.
  expect(box(host).value).toBe(`${harness.tmp}/notes.md`);
});

test("the keys are the dialog's, so a click on a row does not disarm them", async () => {
  const host = await open();

  rows(host)
    .find((row) => row.textContent === "workshop")!
    .click();
  await settle(() => labels(host).includes("four"), "workshop's contents");
  // The click left focus on the dialog, the way it does on any row that is
  // not a control: the arrows and Enter answer from there or not at all.
  box(host).blur();
  panel(host).focus();
  expect(document.activeElement).toBe(panel(host));

  send(panel(host), "ArrowDown");
  expect(selected(host)).toBe("one");

  send(panel(host), "Enter");
  await settle(
    () => box(host).value === `${join(workshop, "one")}/`,
    "the row walked to"
  );
  expect(store.state.cwd).toBe(harness.tmp);
});

test("Alt+↑ walks to the enclosing directory, and Meta+↑ with it", async () => {
  const host = await open();

  for (const chord of [{ altKey: true }, { metaKey: true }]) {
    type(host, `${workshop}/`);
    await settle(() => labels(host).includes("four"), "workshop's contents");

    press(host, "ArrowUp", chord);

    // The shortcut is the ↑ button: the box moved out, the session stayed.
    expect(box(host).value).toBe(`${harness.tmp}/`);
    expect(store.state.cwd).toBe(harness.tmp);
  }
});

test("a bare ↑ is still the caret's, not a step upwards", async () => {
  const host = await open();

  type(host, `${workshop}/`);
  await settle(() => labels(host).includes("four"), "workshop's contents");

  press(host, "ArrowUp");

  expect(selected(host)).toBe("two");
  expect(box(host).value).toBe(`${workshop}/`);
});

test("Alt+↑ at the root of the filesystem has nowhere to go", async () => {
  const host = await open();

  type(host, "/");
  await settle(() => parent(host).disabled, "the root listing");
  const lit = selected(host);

  press(host, "ArrowUp", { altKey: true });

  // Its own parent, so the key is spent rather than handed to the caret.
  expect(box(host).value).toBe("/");
  expect(selected(host)).toBe(lit);
});

test("a key aimed at a button belongs to that button", async () => {
  const host = await open();
  const first = store.state.sessionId;

  type(host, `${workshop}/`);
  await settle(() => labels(host).includes("four"), "workshop's contents");
  expect(selected(host)).toBe("four");

  action(host).focus();
  send(action(host), "Enter");

  // Left alone for the button's own activation, which is the click the
  // browser makes of it: the lit row was never stepped into.
  expect(box(host).value).toBe(`${workshop}/`);

  // The arrows are nobody's activation, though, so a caret parked on a
  // button by a click still moves the list.
  send(action(host), "ArrowDown");
  expect(selected(host)).toBe("one");

  action(host).click();
  await settle(
    () => store.state.cwd === workshop,
    "the new session's directory"
  );
  expect(store.state.sessionId).not.toBe(first);
});
