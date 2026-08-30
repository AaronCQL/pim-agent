import "./test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { ServerEvent } from "../../protocol/src/ServerEvent";
import { Shell } from "./App";
import { SessionStore } from "./session/SessionStore";
import { mountPoint } from "./test/dom";
import { GatewayHarness, until } from "./test/gateway";

const VIEW = { title: [{ kind: "text" as const, text: "rm -rf /" }] };

function attached(sessionId = "s1"): ServerEvent {
  return {
    type: "attached",
    protocolVersion: 3,
    sessionId,
    cwd: "/repo",
    head: 0,
  };
}

function paint(store: SessionStore): HTMLElement {
  const host = mountPoint();
  render(() => <Shell store={store} />, host);
  flush();
  return host;
}

function offline(): SessionStore {
  return new SessionStore({ url: "ws://127.0.0.1:1", pickerDebounceMs: 0 });
}

describe("the shell, painted from events alone", () => {
  test("paints the streaming turn and then the durable message", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      seq: 2,
      type: "message",
      messageId: "u1",
      role: "user",
      text: "hello",
    });
    store.ingest({
      type: "message_start",
      role: "assistant",
      messageId: "live-1",
    });
    store.ingest({ type: "text_delta", messageId: "live-1", delta: "## Do" });
    flush();
    expect(host.textContent).toContain("hello");

    store.ingest({ type: "text_delta", messageId: "live-1", delta: "ne\n\n" });
    flush();
    expect(host.querySelector(".pim-markdown h2")?.textContent).toBe("Done");

    store.ingest({
      seq: 3,
      type: "message",
      messageId: "a1",
      role: "assistant",
      text: "## Done\n",
    });
    flush();
    expect(host.querySelectorAll(".pim-markdown h2")).toHaveLength(1);
  });

  test("a pending approval is offered, and answering clears it", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      type: "approval_request",
      callId: "c1",
      name: "shell",
      view: VIEW,
      reason: "shell declares an unbounded effect",
    });
    flush();

    const panel = host.querySelector('[aria-label="Tool approvals"]')!;
    expect(panel.textContent).toContain("rm -rf /");
    expect(panel.textContent).toContain("unbounded effect");

    const deny = [...panel.querySelectorAll("button")].find(
      (button) => button.textContent === "Deny"
    )!;
    deny.click();
    flush();

    expect(host.querySelector('[aria-label="Tool approvals"]')).toBeNull();
  });

  test("an approval parked before this client existed still renders", () => {
    const store = offline();
    const host = paint(store);

    // Exactly the frame order of a late attach: the snapshot carries the
    // parked request, and nothing about it says it is old.
    store.ingest(attached());
    store.ingest({
      type: "approval_request",
      callId: "c9",
      name: "shell",
      view: VIEW,
      reason: "parked an hour ago",
    });
    store.ingest({
      type: "session_state",
      cwd: "/repo",
      model: "echo",
      thinking: "off",
      cost: 0,
      status: "tool",
    });
    flush();

    expect(host.textContent).toContain("parked an hour ago");
    expect(host.textContent).toContain("running tool");
  });

  test("the footer paints connection and session state", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      type: "session_state",
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 1.25,
      status: "streaming",
      tps: 30.4,
    });
    flush();

    const footer = host.querySelector("footer")!;
    expect(footer.textContent).toContain("sonnet");
    expect(footer.textContent).toContain("30 tok/s");
    expect(footer.textContent).toContain("$1.2500");
    expect(footer.textContent).toContain("streaming");
  });
});

describe("the composer, against a real gateway", () => {
  let harness: GatewayHarness;
  let store: SessionStore;

  beforeEach(async () => {
    harness = new GatewayHarness();
    await harness.start();
    await Bun.write(`${harness.tmp}/greeter.ts`, "export const x = 1;\n");
    store = new SessionStore({
      url: harness.url,
      cwd: harness.tmp,
      pickerDebounceMs: 0,
    });
    await store.connect();
  });

  afterEach(async () => {
    store.dispose();
    await harness.stop();
  });

  test("typing `@` queries the server and Enter completes the token", async () => {
    const host = paint(store);
    const input = host.querySelector("textarea")!;

    type(input, "look at @gre");
    await until(() => options(host).length > 0, "the server's answer");
    expect(options(host)[0]?.textContent).toContain("greeter.ts");

    press(input, "Enter");
    flush();
    expect(input.value).toBe("look at @greeter.ts");
    expect(options(host)).toHaveLength(0);
  });

  test("ESC closes the picker without touching the draft", async () => {
    const host = paint(store);
    const input = host.querySelector("textarea")!;

    type(input, "@gre");
    await until(() => options(host).length > 0, "the server's answer");

    press(input, "Escape");
    flush();
    expect(input.value).toBe("@gre");
    expect(options(host)).toHaveLength(0);
  });

  test("the switcher lists the sessions pi has on disk", async () => {
    const host = paint(store);
    await store.prompt("say hello");
    await until(
      () => store.state.durable.length > 0,
      "the durable user message"
    );

    [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Sessions"))!
      .click();
    flush();
    await until(
      () =>
        (host.querySelector("dialog")?.textContent ?? "").includes(
          store.state.sessionId.slice(0, 8)
        ),
      "the catalogue"
    );

    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain(harness.tmp);
    expect(dialog.textContent).toContain("New in this directory");
  });
});

/** Rows the user can actually see; a closed popover keeps its list mounted. */
function options(host: HTMLElement): readonly Element[] {
  const panel = host.querySelector("[popover]");
  if (panel === null || panel.className.includes("hidden")) {
    return [];
  }
  return [...panel.querySelectorAll('[role="option"]')];
}

function type(input: HTMLTextAreaElement, text: string): void {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function press(input: HTMLTextAreaElement, key: string): void {
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  );
}
