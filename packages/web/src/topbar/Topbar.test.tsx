import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { CLOSE_PROTOCOL_MISMATCH, PROTOCOL_VERSION } from "#protocol/Protocol";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { until } from "../test/gateway";
import { Topbar } from "./Topbar";

function stocked(cwd: string, branch: string): SessionStore {
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
    cwd,
    model: "sonnet",
    thinking: "medium",
    cost: 0,
    status: "idle",
    branch,
    dirtyCount: 3,
    ahead: 2,
    behind: 1,
  });
  return store;
}

function paint(
  store: SessionStore,
  compact: boolean,
  onOpenSettings = (): void => {}
): HTMLElement {
  const host = mountPoint();
  render(
    () => (
      <Topbar
        store={store}
        compact={compact}
        onToggleSidebar={() => {}}
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
    expect(host.textContent).toContain("●3");
    expect(host.textContent).toContain("↑2");
    expect(host.textContent).toContain("↓1");
  });

  test("a phone gets the directory and the state, not the route there", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "main"), true);

    expect(host.textContent).toContain("pim-agent");
    expect(host.textContent).not.toContain("~/src");
    // Which branch and how dirty survive; how far it has drifted does not.
    expect(host.textContent).toContain("main");
    expect(host.textContent).toContain("●3");
    expect(host.textContent).not.toContain("↑2");
    expect(host.textContent).not.toContain("↓1");
  });

  /**
   * Nothing counts characters: the head is a shrinking box under an ellipsis
   * and the tail a fixed one, so a row with room paints the text whole and a
   * tight one elides exactly its overflow, at whatever width that happens.
   */
  test("text is cut so a squeeze takes the middle and spares the end", () => {
    const host = paint(stocked("/home/ada/src/pim-agent", "feat/chips"), false);

    const heads = [...host.querySelectorAll("span.truncate")].map(
      (node) => node.textContent
    );
    expect(heads).toEqual(["~/src/", "feat/"]);
    expect(host.textContent).toContain("~/src/pim-agent");
  });
});
