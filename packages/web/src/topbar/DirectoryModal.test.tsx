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

// Runs against a real gateway and a temp directory tree.

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
  // `work` and `workshop` share a prefix; `workshop` has several children.
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

/** Opens the modal and waits for the first listing. */
async function open(): Promise<HTMLElement> {
  const host = paint();
  chip(host).click();
  flush();
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

function parent(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    '[aria-label="Parent directory"]'
  )!;
}

/** The "New Session" button. */
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

function send(element: Element, key: string, chord: Chord = {}): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { key, ...chord, bubbles: true })
  );
  flush();
}

function press(host: HTMLElement, key: string, chord: Chord = {}): void {
  send(box(host), key, chord);
}

function selected(host: HTMLElement): string | undefined {
  return (
    rows(host).find((row) => row.getAttribute("aria-selected") === "true")
      ?.textContent ?? undefined
  );
}

function settle(test: () => boolean, label: string): Promise<void> {
  return until(() => {
    flush();
    return test();
  }, label);
}

test("the chip opens on the current directory, hiding what starts with a dot", async () => {
  const host = await open();

  expect(box(host).value).toBe(`${harness.tmp}/`);
  // Focus must come from `autofocus`, or the dialog focuses its close button.
  expect(box(host).hasAttribute("autofocus")).toBe(true);
  expect(box(host).selectionEnd).toBe(box(host).value.length);
  expect(labels(host)).toContain("alpha");
  expect(labels(host)).toContain("beta");
  expect(labels(host)).not.toContain(".hidden");
  expect(action(host).disabled).toBe(false);
});

test("a dot is how the hidden directories are asked for", async () => {
  const host = await open();

  type(host, `${harness.tmp}/.hid`);

  // A partial name isn't a directory, so the button is disabled.
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

  expect(box(host).value).toBe(`${alpha}/`);
  expect(store.state.cwd).toBe(harness.tmp);
  expect(action(host).disabled).toBe(false);
});

test("the arrows light a row, Enter walks to it, and every new set of rows starts at the top", async () => {
  const host = await open();

  press(host, "ArrowDown");
  expect(selected(host)).toBe(labels(host)[1]);

  type(host, `${harness.tmp}/w`);
  expect(labels(host)).toEqual(["work", "workshop", "New folder “w”"]);
  expect(selected(host)).toBe("work");

  press(host, "ArrowDown");
  press(host, "Enter");
  await settle(() => labels(host).includes("four"), "workshop's contents");

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

  // Opens the box's path, not the selected row.
  expect(store.state.sessionId).not.toBe(first);
  expect(host.querySelector("dialog")?.open).toBe(false);
});

test("the button opens a second session in the directory already open", async () => {
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

  // The stale listing must not enable the button.
  expect(action(host).disabled).toBe(true);
  await settle(() => action(host).disabled === false, "the current directory");
  expect(box(host).value).toBe(`${harness.tmp}/`);
});

test("a name nothing answers to is offered as a folder to make", async () => {
  const host = await open();

  type(host, `${harness.tmp}/gamma`);

  expect(labels(host)).toEqual(["New folder “gamma”"]);
  expect(action(host).disabled).toBe(true);

  rows(host).at(-1)!.click();
  await settle(
    () => box(host).value === `${join(harness.tmp, "gamma")}/`,
    "the new directory"
  );

  expect((await stat(join(harness.tmp, "gamma"))).isDirectory()).toBe(true);
  await settle(() => action(host).disabled === false, "somewhere to open");
  expect(store.state.cwd).toBe(harness.tmp);
});

test("a folder that cannot be made says why, where the listing would", async () => {
  // Files aren't listed, but their names are taken.
  await Bun.write(join(harness.tmp, "notes.md"), "# hi\n");
  const host = await open();

  type(host, `${harness.tmp}/notes.md`);
  expect(labels(host)).toEqual(["New folder “notes.md”"]);

  rows(host).at(-1)!.click();
  await settle(
    () => (host.textContent ?? "").includes("already exists"),
    "the refusal"
  );
  expect(box(host).value).toBe(`${harness.tmp}/notes.md`);
});

test("the keys are the dialog's, so a click on a row does not disarm them", async () => {
  const host = await open();

  rows(host)
    .find((row) => row.textContent === "workshop")!
    .click();
  await settle(() => labels(host).includes("four"), "workshop's contents");
  // Clicking a row leaves focus on the dialog itself.
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

  // Enter is left to the button; the row isn't entered.
  expect(box(host).value).toBe(`${workshop}/`);

  // Arrows still move the list.
  send(action(host), "ArrowDown");
  expect(selected(host)).toBe("one");

  action(host).click();
  await settle(
    () => store.state.cwd === workshop,
    "the new session's directory"
  );
  expect(store.state.sessionId).not.toBe(first);
});
