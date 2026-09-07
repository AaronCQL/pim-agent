import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { flush } from "solid-js";

import type { CommandDraft } from "#protocol/Command";
import { Shell } from "../App";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { GatewayHarness } from "../test/gateway";
import { Sidebar } from "./Sidebar";

let harness: GatewayHarness;
let store: SessionStore;
let dispose: (() => void) | undefined;
let commands: CommandDraft[];

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  harness = new GatewayHarness();
  await harness.start();
  store = new SessionStore({ url: harness.url, cwd: harness.tmp });
  await store.connect();
  commands = [];
  spyOn(store.client, "send").mockImplementation(async (command) => {
    commands.push(command);
    return { type: "response", id: "1", success: true, sessions: [] };
  });
});

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  store.dispose();
  await harness.stop();
  mock.restore();
});

function paint(shell = false): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => (shell ? <Shell store={store} /> : <Sidebar store={store} />),
    host
  );
  flush();
  return host;
}

function button(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    '[aria-label="Update and restart"]'
  )!;
}

test("the sidebar footer restarts once, shows progress, and recovers from failure", () => {
  const host = paint();
  const restart = button(host);
  expect(restart.disabled).toBe(false);
  restart.click();
  flush();
  expect(commands.filter(({ type }) => type === "reload")).toEqual([
    { type: "reload" },
  ]);
  expect(restart.disabled).toBe(true);
  expect(restart.querySelector(".animate-spin")).not.toBeNull();
  restart.click();
  expect(commands.filter(({ type }) => type === "reload")).toHaveLength(1);
  store.ingest({
    type: "update_state",
    phase: "step",
    label: "build the web client",
  });
  flush();
  expect(restart.title).toBe("build the web client");
  store.ingest({
    type: "update_state",
    phase: "failed",
    error: "build failed",
  });
  flush();
  expect(restart.disabled).toBe(false);
  expect(restart.querySelector(".animate-spin")).toBeNull();
});

test("killing a turn in another session requires confirmation before force is sent", () => {
  const host = paint();
  store.ingest({
    type: "session_activity",
    sessionId: "other",
    status: "thinking",
  });
  flush();
  const confirm = spyOn(window, "confirm").mockReturnValue(false);
  button(host).click();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(commands.some(({ type }) => type === "reload")).toBe(false);
  confirm.mockReturnValue(true);
  button(host).click();
  expect(commands.filter(({ type }) => type === "reload")).toEqual([
    { type: "reload", force: true },
  ]);
});

test("the footer cannot send a restart on a disconnected socket", () => {
  const host = paint();
  store.client.close();
  flush();
  expect(button(host).disabled).toBe(true);
  button(host).click();
  expect(commands.some(({ type }) => type === "reload")).toBe(false);
});

test("the shell paints progress and a dismissible result outside the sidebar", () => {
  const host = paint(true);
  store.ingest({ type: "update_state", phase: "step", label: "bun install" });
  flush();
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "bun install"
  );
  store.ingest({
    type: "update_state",
    phase: "failed",
    error: "install failed",
  });
  flush();
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Update failed: install failed"
  );
  host
    .querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!
    .click();
  flush();
  expect(host.querySelector('[role="status"]')).toBeNull();
});

test("the reloaded shell toasts success only after attaching and consumes the intent", async () => {
  const key = `pim.reload:${harness.url}`;
  sessionStorage.setItem(
    key,
    JSON.stringify({
      deadline: Date.now() + 180_000,
      phase: "loaded",
      target: { sessionId: store.state.sessionId, cwd: harness.tmp },
      skipped: "",
    })
  );
  store.dispose();
  store = new SessionStore({ url: harness.url });
  const host = paint(true);
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Waiting for server"
  );
  await store.connect();
  flush();
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Restarted with pim"
  );
  expect(host.querySelector('[role="status"]')?.className).toContain(
    "text-emerald-400"
  );
  expect(sessionStorage.getItem(key)).toBeNull();
});
