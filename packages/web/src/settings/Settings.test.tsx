import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { Transcript } from "../transcript/Transcript";
import { HideThinking, Settings } from "./Settings";
import { SettingsModal } from "./SettingsModal";

let dispose: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

test("an empty address is this origin, and every way of typing one is a socket", () => {
  const settings = new Settings();
  expect(settings.gateway()).toBe(`ws://${location.host}`);
  const cases: Record<string, string> = {
    "laptop:4319": "ws://laptop:4319",
    "http://laptop:4319": "ws://laptop:4319",
    "https://pim.example.com": "wss://pim.example.com",
    "ws://laptop:4319": "ws://laptop:4319",
    "wss://pim.example.com/": "wss://pim.example.com",
    "  laptop:4319  ": "ws://laptop:4319",
  };
  for (const [typed, expected] of Object.entries(cases)) {
    settings.setServerUrl(typed);
    expect(settings.gateway()).toBe(expected);
  }
});

/**
 * A typo must not be able to strand the app with nowhere to connect: the
 * modal that repairs it is only reachable from a shell that mounted.
 */
test("an address that cannot be read falls back to this origin", () => {
  const settings = new Settings();
  settings.setServerUrl("file:///etc/passwd");
  expect(settings.gateway()).toBe(`ws://${location.host}`);
});

test("preferences survive the tab that set them", () => {
  const settings = new Settings();
  settings.setServerUrl("laptop:4319");
  settings.setHideThinking(true);
  const reopened = new Settings();
  expect(reopened.state.serverUrl).toBe("laptop:4319");
  expect(reopened.state.hideThinking).toBe(true);
  expect(reopened.gateway()).toBe("ws://laptop:4319");
});

test("junk in storage reads as the defaults rather than throwing", () => {
  localStorage.setItem("pim.settings", "{not json");
  const settings = new Settings();
  expect(settings.state.serverUrl).toBe("");
  expect(settings.state.hideThinking).toBe(false);
});

/** The whole point of the preference, at the one place it is read. */
test("hidden thinking keeps reasoning out of the transcript", () => {
  const host = mountPoint();
  const settings = new Settings();
  dispose = render(
    () => (
      <HideThinking value={() => settings.state.hideThinking}>
        <Transcript
          events={[
            {
              type: "message",
              seq: 1,
              messageId: "a1",
              role: "assistant",
              text: "Done.",
              thinking: "Let me look.",
              timestamp: 0,
            },
          ]}
        />
      </HideThinking>
    ),
    host
  );
  flush();
  expect(host.textContent).toContain("Let me look.");
  settings.setHideThinking(true);
  flush();
  expect(host.textContent).not.toContain("Let me look.");
  expect(host.textContent).toContain("Done.");
});

/**
 * Saving an address is a navigation, not a reconnect: one URL is baked into
 * the socket, the upload endpoint and every image link at construction.
 */
test("a saved address is persisted and the page is sent to it", () => {
  const { host, settings, reloads, store } = open();
  const field = host.querySelector<HTMLInputElement>(
    '[aria-label="Server address"]'
  )!;
  const connect = press(host, "Connect");
  expect(connect.disabled).toBe(true);
  field.value = "laptop:4319";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(connect.disabled).toBe(false);
  connect.click();
  flush();
  expect(reloads).toEqual(["ws://laptop:4319"]);
  expect(settings.gateway()).toBe("ws://laptop:4319");
  expect(new Settings().state.serverUrl).toBe("laptop:4319");
  store.dispose();
});

/** The way back from a typo, on the tab that can no longer reach anything. */
test("this device is offered as somewhere to go back to, and only then", () => {
  localStorage.setItem(
    "pim.settings",
    JSON.stringify({ serverUrl: "laptop:4319", hideThinking: false })
  );
  const away = open();
  press(away.host, "Use this device").click();
  flush();
  expect(away.reloads).toEqual([`ws://${location.host}`]);
  expect(new Settings().state.serverUrl).toBe("");
  away.store.dispose();
  away.dispose();

  const home = open();
  expect(
    [...home.host.querySelectorAll("button")].some(
      (element) => element.textContent === "Use this device"
    )
  ).toBe(false);
  home.store.dispose();
});

function press(host: HTMLElement, label: string): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find(
    (element) => element.textContent === label
  )!;
}

function open(): {
  readonly host: HTMLElement;
  readonly settings: Settings;
  readonly store: SessionStore;
  readonly reloads: string[];
  readonly dispose: () => void;
} {
  const reloads: string[] = [];
  const settings = new Settings();
  const store = new SessionStore({
    url: "ws://127.0.0.1:1",
    reloadPage: () => reloads.push(settings.gateway()),
  });
  const host = mountPoint();
  const release = render(
    () => (
      <SettingsModal
        open={true}
        store={store}
        settings={settings}
        onClose={() => {}}
      />
    ),
    host
  );
  dispose = release;
  flush();
  return { host, settings, store, reloads, dispose: release };
}
