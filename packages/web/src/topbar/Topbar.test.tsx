import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { PROTOCOL_VERSION } from "#protocol/Protocol";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
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

function paint(store: SessionStore, compact: boolean): HTMLElement {
  const host = mountPoint();
  render(
    () => <Topbar store={store} compact={compact} onToggleSidebar={() => {}} />,
    host
  );
  flush();
  return host;
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
