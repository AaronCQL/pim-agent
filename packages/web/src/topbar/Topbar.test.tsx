import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { until } from "#core/shared/fixtures/wait";
import { Topbar } from "./Topbar";

function stocked(cwd: string, branch: string, dirtyCount = 3): SessionStore {
  const store = new SessionStore({ url: "ws://127.0.0.1:1" });
  store.ingest({
    type: "attached",
    sessionId: "s1",
    cwd,
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  });
  store.ingest({
    type: "session_state",
    writable: true,
    cwd,
    model: "sonnet",
    thinking: "medium",
    cost: 0,
    status: "idle",
    branch,
    dirtyCount,
    ahead: 2,
    behind: 1,
  });
  return store;
}

function paint(
  store: SessionStore,
  compact: boolean,
  onOpenSettings = (): void => {},
  onToggleDiff = (): void => {},
  reviewing = false
): HTMLElement {
  const host = mountPoint();
  render(
    () => (
      <Topbar
        store={store}
        compact={compact}
        reviewing={reviewing}
        onToggleSidebar={() => {}}
        onToggleDiff={onToggleDiff}
        onOpenSettings={onOpenSettings}
        graceMs={0}
      />
    ),
    host
  );
  flush();
  return host;
}

function changes(host: HTMLElement): HTMLButtonElement {
  const found = host
    .querySelector(".i-griddy-icons\\:file-edit")
    ?.closest("button");
  if (!found) {
    throw new Error("the changes segment is not painted");
  }
  return found;
}

function mark(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('[aria-label="Not connected"]');
}

describe("the disconnected mark", () => {
  test("shows only once a socket has been down, and leads to the address", async () => {
    const store = stocked("/repo", "main");
    const opened: number[] = [];
    const host = paint(store, false, () => opened.push(1));
    expect(mark(host)).toBeNull();

    // No gateway: connecting, then reconnecting forever.
    void store.client.connect().catch(() => undefined);
    await until(() => {
      flush();
      return mark(host) !== null;
    }, "the disconnected mark");
    expect(host.textContent).toContain("Not connected");
    mark(host)!.click();
    expect(opened).toHaveLength(1);

    store.dispose();
    flush();
  });

  test("stays away for a tab running another build", () => {
    // `stocked` attaches to a server on 1.2.3, which is not this bundle.
    const store = stocked("/repo", "main");
    const host = paint(store, false);
    flush();
    expect(store.update.state.stale).toBe(true);
    expect(mark(host)).toBeNull();
    store.dispose();
  });
});

describe("the topbar's chips", () => {
  test("a wide row spells the whole path and the divergence", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "main"), false);

    expect(host.textContent).toContain("~/src/pim-agent");
    expect(host.textContent).toContain("main");
    expect(changes(host).textContent).toBe("3");
    expect(host.textContent).toContain("↑2↓1");
  });

  test("a phone gets the directory and the state, not the route there", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "main"), true);

    expect(host.textContent).toContain("pim-agent");
    expect(host.textContent).not.toContain("~/src");
    expect(host.textContent).toContain("main");
    expect(changes(host).textContent).toBe("3");
    expect(host.textContent).not.toContain("↑2");
    expect(host.textContent).not.toContain("↓1");
  });

  test("the changes segment leads straight to the diff", () => {
    const toggled: number[] = [];
    const host = paint(
      stocked("/home/ada/src/pim-agent", "main"),
      false,
      () => {},
      () => toggled.push(1)
    );

    expect(changes(host).getAttribute("aria-label")).toBe(
      "Review changes, 3 changed files"
    );
    changes(host).click();
    expect(toggled).toHaveLength(1);
  });

  test("the segment is the way back out of the change set it opened", () => {
    const host = paint(
      stocked("/home/ada/src/pim-agent", "main"),
      false,
      () => {},
      () => {},
      true
    );

    expect(changes(host).getAttribute("aria-pressed")).toBe("true");
    expect(changes(host).getAttribute("aria-label")).toBe(
      "Back to the conversation"
    );
  });

  test("a clean tree keeps the segment, without the count", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "main", 0), false);

    expect(changes(host).getAttribute("aria-label")).toBe(
      "Review changes, working tree clean"
    );
    expect(changes(host).textContent).toBe("");
    expect(host.querySelector(".text-amber-400")).toBeNull();
  });
});
