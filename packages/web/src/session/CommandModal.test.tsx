import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { ServerEvent } from "#protocol/ServerEvent";
import { mountPoint } from "../test/dom";
import { CommandModal } from "./CommandModal";
import { SessionStore } from "./SessionStore";

type Sent = Record<string, unknown> & { readonly type: string };

type Painted = {
  readonly host: HTMLElement;
  readonly store: SessionStore;
  readonly sent: readonly Sent[];
  readonly feed: (...events: readonly ServerEvent[]) => void;
};

let dispose: (() => void) | undefined;
let store: SessionStore | undefined;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  store?.dispose();
  store = undefined;
  flush();
});

function paint(): Painted {
  const target = new SessionStore({ url: "ws://127.0.0.1:1" });
  store = target;
  const sent: Sent[] = [];
  target.client.send = (async (command: Sent) => {
    sent.push(command);
    return { type: "response", id: "1", success: true };
  }) as typeof target.client.send;
  const host = mountPoint();
  dispose = render(() => <CommandModal store={target} />, host);
  flush();
  const feed = (...events: readonly ServerEvent[]): void => {
    for (const event of events) {
      target.ingest(event);
    }
    flush();
  };
  feed({
    type: "attached",
    sessionId: "s1",
    cwd: "/repo",
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  });
  return { host, store: target, sent, feed };
}

/** What a command said; an unnamed one is a toast, and is spelled out where it is tested. */
function notice(
  id: string,
  text: string,
  command = "/claude-quota"
): ServerEvent {
  return { type: "ui_notice", id, severity: "info", text, command };
}

function panel(host: HTMLElement): HTMLDialogElement {
  return host.querySelector("dialog")!;
}

function buttons(host: HTMLElement): readonly HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("dialog button")];
}

function press(host: HTMLElement, label: string): void {
  const found = buttons(host).find(
    (button) =>
      button.textContent?.trim() === label ||
      button.getAttribute("aria-label") === label
  );
  if (found === undefined) {
    throw new Error(`no button called ${label}`);
  }
  found.click();
  flush();
}

describe("the command modal", () => {
  test("one dispatch's notices are one panel, rendered as Markdown", () => {
    const { host, feed } = paint();
    feed(
      notice("n1", "## Claude Quotas\n\n- account: 40%\n"),
      notice("n2", "Cache **enabled**.")
    );

    expect(host.querySelectorAll("dialog")).toHaveLength(1);
    expect(panel(host).open).toBe(true);
    expect(panel(host).querySelector("h2")?.textContent).toBe("Claude Quotas");
    expect(panel(host).querySelector("strong")?.textContent).toBe("enabled");
    expect(panel(host).textContent).toContain("account: 40%");
    // One per notice: each is a document somebody may want out of the browser.
    expect(
      buttons(host).filter(
        (button) => button.getAttribute("aria-label") === "Copy notice"
      )
    ).toHaveLength(2);
  });

  test("a notice nobody asked for never opens it", () => {
    const { host, feed } = paint();
    feed({
      type: "ui_notice",
      id: "n1",
      severity: "info",
      text: "The cache finished warming.",
    });

    expect(panel(host).open).toBe(false);
  });

  test("the command that opened it is what it is called", () => {
    const { host, feed } = paint();
    feed(notice("n1", "fine", "/claude-logging"));

    expect(panel(host).querySelector("header")?.textContent).toContain(
      "/claude-logging"
    );
  });

  test("a question that opened it names it too", () => {
    const { host, feed } = paint();
    feed({
      type: "ui_request",
      requestId: "r1",
      method: "confirm",
      title: "Drop the table?",
      command: "/login",
    });

    expect(panel(host).querySelector("header")?.textContent).toContain(
      "/login"
    );
  });

  /** Nothing named it, so it falls back to what every such panel is. */
  test("an unprompted question is a command panel all the same", () => {
    const { host, feed } = paint();
    feed({
      type: "ui_request",
      requestId: "r1",
      method: "confirm",
      title: "Drop the table?",
    });

    expect(panel(host).querySelector("header")?.textContent).toContain(
      "Command"
    );
  });

  test("a select offers its options, and the press names the one chosen", () => {
    const { host, sent, feed } = paint();
    feed({
      type: "ui_request",
      requestId: "r1",
      method: "select",
      title: "Which account?",
      options: ["personal", "work"],
    });

    expect(panel(host).open).toBe(true);
    expect(panel(host).textContent).toContain("Which account?");

    press(host, "work");

    expect(sent).toEqual([
      { type: "ui_response", sessionId: "s1", requestId: "r1", value: "work" },
    ]);
    // Nothing left pending and nothing said: the panel is done.
    expect(panel(host).open).toBe(false);
  });

  test("a confirm answers yes or no, never silence", () => {
    const { host, sent, feed } = paint();
    feed({
      type: "ui_request",
      requestId: "r1",
      method: "confirm",
      title: "Drop the table?",
      message: "This cannot be undone.",
    });

    expect(panel(host).textContent).toContain("This cannot be undone.");
    press(host, "No");

    expect(sent).toEqual([
      {
        type: "ui_response",
        sessionId: "s1",
        requestId: "r1",
        confirmed: false,
      },
    ]);
  });

  test("an input sends what was typed, on the button or on Enter", () => {
    const { host, sent, feed } = paint();
    feed({
      type: "ui_request",
      requestId: "r1",
      method: "input",
      title: "Paste the code",
      placeholder: "code",
    });

    const box = panel(host).querySelector<HTMLInputElement>(
      '[aria-label="Paste the code"]'
    )!;
    expect(box.placeholder).toBe("code");
    // Nothing typed is nothing to send.
    expect(
      buttons(host).find((button) => button.textContent?.trim() === "Send")
        ?.disabled
    ).toBe(true);

    box.value = "42";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    box.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    flush();

    expect(sent).toEqual([
      { type: "ui_response", sessionId: "s1", requestId: "r1", value: "42" },
    ]);
  });

  test("a dialog answered elsewhere loses its control and leaves the words standing", () => {
    const { host, sent, feed } = paint();
    feed(notice("n1", "Signing in…"), {
      type: "ui_request",
      requestId: "r1",
      method: "input",
      title: "Paste the code",
    });
    expect(panel(host).querySelector('[aria-label="Paste the code"]')).not.toBe(
      null
    );

    feed({ type: "ui_request_done", requestId: "r1" });

    expect(panel(host).querySelector('[aria-label="Paste the code"]')).toBe(
      null
    );
    // The panel stays: what the command already said is still worth reading.
    expect(panel(host).open).toBe(true);
    expect(panel(host).textContent).toContain("Signing in…");
    expect(sent).toEqual([]);
  });

  /** Two dispatches nest, so two questions can stand at once and the panel asks them in turn. */
  test("a second question waits its turn, and keeps the panel when the first is answered", () => {
    const { host, sent, feed } = paint();
    feed(
      {
        type: "ui_request",
        requestId: "r1",
        method: "confirm",
        title: "Drop the table?",
      },
      {
        type: "ui_request",
        requestId: "r2",
        method: "select",
        title: "Which account?",
        options: ["personal", "work"],
      }
    );

    expect(panel(host).textContent).toContain("Drop the table?");
    expect(panel(host).textContent).not.toContain("Which account?");

    press(host, "Yes");

    expect(sent).toEqual([
      {
        type: "ui_response",
        sessionId: "s1",
        requestId: "r1",
        confirmed: true,
      },
    ]);
    expect(panel(host).open).toBe(true);
    expect(panel(host).textContent).toContain("Which account?");

    press(host, "work");

    expect(sent.at(-1)).toEqual({
      type: "ui_response",
      sessionId: "s1",
      requestId: "r2",
      value: "work",
    });
    expect(panel(host).open).toBe(false);
  });

  test("closing it cancels the question and clears the stack", () => {
    const { host, sent, feed } = paint();
    feed(notice("n1", "Signing in…"), {
      type: "ui_request",
      requestId: "r1",
      method: "input",
      title: "Paste the code",
    });

    press(host, "Close");

    expect(sent).toEqual([
      {
        type: "ui_response",
        sessionId: "s1",
        requestId: "r1",
        cancelled: true,
      },
    ]);
    expect(panel(host).open).toBe(false);

    // And the next dispatch opens on its own words, not on the last one's.
    feed(notice("n2", "Signed in."));
    expect(panel(host).textContent).not.toContain("Signing in…");
    expect(panel(host).textContent).toContain("Signed in.");
  });

  // The gesture a phone dismisses with, which `Modal` arms for every overlay.
  test("the back gesture cancels what the close button cancels", () => {
    const { host, sent, feed } = paint();
    feed({
      type: "ui_request",
      requestId: "r1",
      method: "confirm",
      title: "Drop the table?",
    });

    globalThis.dispatchEvent(new Event("popstate"));
    flush();

    expect(sent).toEqual([
      {
        type: "ui_response",
        sessionId: "s1",
        requestId: "r1",
        cancelled: true,
      },
    ]);
    expect(panel(host).open).toBe(false);
  });
});
