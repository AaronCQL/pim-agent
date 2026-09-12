import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { CLOSE_PROTOCOL_MISMATCH, PROTOCOL_VERSION } from "#protocol/Protocol";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { until } from "../test/gateway";
import { Topbar } from "./Topbar";

function stocked(cwd: string, branch: string, dirtyCount = 3): SessionStore {
  const store = new SessionStore({ url: "ws://127.0.0.1:1" });
  store.ingest({
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
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
        // The grace period is what the mark is *for*; a test that waited it
        // out would be paying 1.5s to assert a `setTimeout`.
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
  /**
   * The only ambient connection signal left in the app, and the reason it is
   * in this bar rather than the sidebar: below `md` the sidebar is a closed
   * drawer, and a phone waking up is how a socket usually dies.
   */
  test("shows only once a socket has been down, and leads to the address", async () => {
    const store = stocked("/repo", "main");
    const opened: number[] = [];
    const host = paint(store, false, () => opened.push(1));
    expect(mark(host)).toBeNull();

    // A gateway that is not there: `connecting`, then `reconnecting` forever.
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

  /**
   * An outdated tab holds a socket the server refused on protocol version.
   * The toast says so in words and the fix is a reload; a mark reading "not
   * connected" would send the reader looking at their network instead.
   */
  test("stays away for a tab the server has refused", async () => {
    const server = refusing();
    const store = new SessionStore({ url: `ws://127.0.0.1:${server.port}` });
    const host = paint(store, false);
    await store.connect().catch(() => undefined);
    await until(
      () => store.state.connection === "outdated",
      "the server to hang up"
    );
    flush();
    expect(mark(host)).toBeNull();
    store.dispose();
    await server.stop(true);
  });
});

/** A newer server meeting an older client: answer, then refuse the version. */
function refusing(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request, self) =>
      self.upgrade(request, { data: undefined })
        ? undefined
        : new Response("no", { status: 400 }),
    websocket: {
      message: (socket, raw) => {
        const { id } = JSON.parse(String(raw)) as { readonly id: string };
        socket.send(
          JSON.stringify({ type: "response", id, success: false, error: "old" })
        );
        socket.close(CLOSE_PROTOCOL_MISMATCH, "protocol version mismatch");
      },
    },
  });
}

describe("the topbar's chips", () => {
  test("a wide row spells the whole path and the divergence", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "main"), false);

    expect(host.textContent).toContain("~/src/pim-agent");
    expect(host.textContent).toContain("main");
    expect(changes(host).textContent).toBe("3");
    // The pair reads as one drift, unsplit by the chip's gap, as in the footer.
    expect(host.textContent).toContain("↑2↓1");
  });

  test("a phone gets the directory and the state, not the route there", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "main"), true);

    expect(host.textContent).toContain("pim-agent");
    expect(host.textContent).not.toContain("~/src");
    // Which branch and how dirty survive; how far it has drifted does not.
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

  /**
   * A clean tree still has a way in — the diff view says so itself — and a
   * segment that came and went would move the branch chip under the pointer
   * every time an agent wrote a file.
   */
  test("a clean tree keeps the segment, without the count", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "main", 0), false);

    expect(changes(host).getAttribute("aria-label")).toBe(
      "Review changes, working tree clean"
    );
    expect(changes(host).textContent).toBe("");
    expect(host.querySelector(".text-amber-400")).toBeNull();
  });

  /**
   * Cutting is measured, not guessed: a copy of the whole text is what the row
   * lays out, and the line the reader gets is painted over it and sliced to the
   * share of that copy the row granted. A DOM with no layout — this one — grants
   * all of it; `fit` is tested on its own arithmetic.
   */
  test("every chip lays out its whole text and paints the fitting one over it", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "feat/chips"), false);

    const laid = [...host.querySelectorAll("span.invisible")];
    expect(laid.map((node) => node.textContent)).toEqual([
      "~/src/pim-agent",
      "feat/chips",
    ]);
    const painted = [...host.querySelectorAll("span.absolute")];
    expect(painted.map((node) => node.textContent)).toEqual([
      "~/src/pim-agent",
      "feat/chips",
    ]);
  });
});
