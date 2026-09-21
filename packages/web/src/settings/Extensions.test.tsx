import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

import type { ExtensionEntry } from "#core/shared/PiExtensions";
import type { CommandDraft } from "#protocol/Command";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { Settings } from "./Settings";
import { SettingsModal } from "./SettingsModal";

let store: SessionStore;
let dispose: (() => void) | undefined;
let sent: CommandDraft[];
let refusal: string | undefined;

const ROSTER: readonly ExtensionEntry[] = [
  {
    id: "pim:todo",
    label: "Todo Tool",
    group: "pim",
    enabled: false,
    writable: true,
  },
  {
    id: "pi:/home/pim/.pi/agent/extensions/notes.ts",
    label: "notes",
    group: "user",
    enabled: true,
    writable: true,
  },
  {
    id: "pi:/repo/.pi/extensions/review.ts",
    label: "review",
    group: "project",
    enabled: true,
    writable: false,
  },
];

beforeEach(() => {
  localStorage.clear();
  sent = [];
  refusal = undefined;
  store = new SessionStore({ url: "ws://127.0.0.1:1" });
  store.client.send = (async (command: CommandDraft) => {
    sent.push(command);
    if (command.type === "list_extensions") {
      return {
        type: "response",
        id: "1",
        success: true,
        extensions: ROSTER,
      };
    }
    return refusal === undefined
      ? { type: "response", id: "1", success: true }
      : { type: "response", id: "1", success: false, error: refusal };
  }) as typeof store.client.send;
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  store.dispose();
});

function paint(open: () => boolean = () => true): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => (
      <SettingsModal
        open={open()}
        store={store}
        settings={new Settings()}
        onClose={() => {}}
      />
    ),
    host
  );
  flush();
  return host;
}

/**
 * Every promise the pane waits on is already resolved, so its work is done
 * within a handful of microtask turns: drain them and paint, no timer in it.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve();
  }
  flush();
}

function toggle(host: HTMLElement, label: string): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

function asked(): readonly CommandDraft[] {
  return sent.filter((command) => command.type === "list_extensions");
}

function section(host: HTMLElement): HTMLElement {
  return [...host.querySelectorAll("section")].find(
    (element) => element.querySelector("h2")?.textContent === "Extensions"
  )!;
}

test("the roster is grouped, badged, and locked where the server will not write", async () => {
  const host = paint();
  expect(section(host).querySelector(".animate-spin")).not.toBeNull();
  await settle();

  const panel = section(host);
  expect(
    [...panel.querySelectorAll("h3")].map((one) => one.textContent)
  ).toEqual(["Installed", "Project"]);
  expect(toggle(host, "Todo Tool").checked).toBe(false);
  expect(toggle(host, "notes").checked).toBe(true);
  expect(panel.textContent).toContain("Project — read-only here");
  expect(toggle(host, "review").disabled).toBe(true);
  expect(toggle(host, "notes").disabled).toBe(false);
  expect(panel.querySelector(".animate-spin")).toBeNull();
});

test("a switch names its own extension and paints before the server answers", async () => {
  const host = paint();
  await settle();

  const splash = toggle(host, "Todo Tool");
  splash.checked = true;
  splash.dispatchEvent(new Event("change", { bubbles: true }));
  flush();

  expect(sent.filter((command) => command.type === "set_extension")).toEqual([
    { type: "set_extension", extensionId: "pim:todo", value: true },
  ]);
  expect(toggle(host, "Todo Tool").checked).toBe(true);
  expect(toggle(host, "Todo Tool").disabled).toBe(true);

  await settle();
  expect(toggle(host, "Todo Tool").disabled).toBe(false);
});

test("a refused switch puts the row back and says why", async () => {
  const host = paint();
  await settle();
  refusal = "settings.json is read-only";

  const notes = toggle(host, "notes");
  notes.checked = false;
  notes.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
  expect(toggle(host, "notes").checked).toBe(false);

  await settle();
  expect(toggle(host, "notes").checked).toBe(true);
  expect(section(host).textContent).toContain("settings.json is read-only");
});

test("a held roster is asked for once, and again once a switch invalidates it", async () => {
  const [open, setOpen] = createSignal(true);
  paint(open);
  await settle();
  expect(asked()).toHaveLength(1);

  setOpen(false);
  flush();
  setOpen(true);
  flush();
  await settle();
  expect(asked()).toHaveLength(1);

  store.ingest({ type: "extensions_changed" });
  flush();
  await settle();
  expect(asked()).toHaveLength(2);
});

test("a roster the server refuses is said rather than drawn, and can be asked for again", async () => {
  store.client.send = (async (command: CommandDraft) => {
    sent.push(command);
    return { type: "response", id: "1", success: false, error: "no agent dir" };
  }) as typeof store.client.send;

  const host = paint();
  await settle();
  expect(section(host).textContent).toContain("no agent dir");

  [...section(host).querySelectorAll("button")]
    .find((element) => element.textContent === "Try again")!
    .click();
  flush();
  await settle();
  expect(asked()).toHaveLength(2);
});
