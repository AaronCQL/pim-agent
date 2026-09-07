import "../test/dom";

import {
  afterEach,
  beforeEach,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
import { flush } from "solid-js";

import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type { ServerEvent, UpdateStateEvent } from "#protocol/ServerEvent";
import { Reload } from "./Reload";
import { SessionStore } from "./SessionStore";

const URL = "ws://127.0.0.1:4319";
const KEY = `pim.reload:${URL}`;
const DISMISS_MS = 10_000;
const TARGET = { sessionId: "s1", cwd: "/repo" };
const ATTACHED: ServerEvent = {
  type: "attached",
  protocolVersion: PROTOCOL_VERSION,
  ...TARGET,
  head: 0,
  pimVersion: "1.2.3",
  piVersion: "0.9.0",
};
const RESTARTING: UpdateStateEvent = {
  type: "update_state",
  phase: "restarting",
  from: "1.2.2",
  to: "1.2.3",
  skipped: [],
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  mock.restore();
});

test("intent survives one page reload, preserves the session, and toasts the running versions once until it self-dismisses", () => {
  const navigate = mock(() => {});
  const update = new Reload(URL, navigate);
  expect(update.begin(TARGET)).toBe(true);
  expect(update.begin(TARGET)).toBe(false);
  expect(sessionStorage.getItem(KEY)).not.toBeNull();
  update.ingest({ type: "update_state", phase: "step", label: "bun install" });
  flush();
  expect(update.state.label).toBe("bun install");

  update.ingest(RESTARTING);
  expect(navigate).not.toHaveBeenCalled();
  update.connection("reconnecting");
  update.connection("open");
  update.connection("open");
  update.ingest(ATTACHED);
  update.connection("outdated");
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(KEY)).not.toBeNull();
  update.dispose();

  const fresh = new SessionStore({ url: URL, reloadPage: navigate });
  expect(fresh.client.sessionId).toBe("s1");
  flush();
  expect(fresh.update.state.notice).toBeUndefined();
  fresh.ingest(ATTACHED);
  flush();
  expect(fresh.update.state.pending).toBe(false);
  expect(fresh.update.state.notice).toEqual({
    tone: "success",
    text: "Restarted with pim 1.2.3.",
  });
  expect(sessionStorage.getItem(KEY)).toBeNull();
  jest.advanceTimersByTime(DISMISS_MS);
  flush();
  expect(fresh.update.state.notice).toBeUndefined();
  fresh.ingest(ATTACHED);
  flush();
  expect(fresh.update.state.notice).toBeUndefined();
  fresh.dispose();
});

test("ordinary reconnects and attaches during an update never claim a completed restart", () => {
  const navigate = mock(() => {});
  const update = new Reload(URL, navigate);
  update.begin(TARGET);
  update.connection("reconnecting");
  update.connection("open");
  update.ingest(ATTACHED);
  flush();
  expect(navigate).not.toHaveBeenCalled();
  expect(update.state.pending).toBe(true);
  expect(update.state.notice).toBeUndefined();
  update.dispose();
});

test("a protocol refusal reloads only an intentional restart, never loops after navigation", () => {
  const navigate = mock(() => {});
  const update = new Reload(URL, navigate);
  update.connection("outdated");
  expect(navigate).not.toHaveBeenCalled();
  update.begin(TARGET);
  update.connection("outdated");
  expect(navigate).toHaveBeenCalledTimes(1);
  update.dispose();

  const fresh = new Reload(URL, navigate);
  fresh.connection("outdated");
  flush();
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(fresh.state.pending).toBe(false);
  expect(fresh.state.notice?.text).toContain("outdated");
  expect(sessionStorage.getItem(KEY)).toBeNull();
  fresh.refresh();
  expect(navigate).toHaveBeenCalledTimes(2);
});

test("other tabs show broadcast progress but never acquire navigation intent", () => {
  const navigate = mock(() => {});
  const update = new Reload(URL, navigate);
  update.ingest({ type: "update_state", phase: "step", label: "build" });
  flush();
  expect(update.state.pending).toBe(true);
  update.ingest(RESTARTING);
  update.connection("reconnecting");
  update.connection("open");
  update.ingest(ATTACHED);
  flush();
  expect(navigate).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(KEY)).toBeNull();
  expect(update.state.pending).toBe(false);
  expect(update.state.notice?.tone).toBe("warning");
});

test("refusal and update failure clear intent and cancel the deadline", () => {
  const update = new Reload(URL);
  update.begin(TARGET);
  update.rejected("session is mid-turn");
  flush();
  expect(update.state.notice?.text).toBe("session is mid-turn");
  expect(sessionStorage.getItem(KEY)).toBeNull();
  expect(update.begin(TARGET)).toBe(true);
  update.ingest(RESTARTING);
  update.ingest({
    type: "update_state",
    phase: "failed",
    error: "shutdown failed",
  });
  jest.advanceTimersByTime(180_000);
  flush();
  expect(update.state.pending).toBe(false);
  expect(update.state.notice?.text).toBe("Update failed: shutdown failed");
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

test("an unsupervised server asks for a manual restart and reports skips", () => {
  const navigate = mock(() => {});
  const update = new Reload(URL, navigate);
  update.begin(TARGET);
  update.ingest({
    ...RESTARTING,
    phase: "stranded",
    // A note cannot soften this one: the restart itself is still owed.
    skipped: [{ label: "git pull", reason: "dirty tree", blocking: false }],
  });
  flush();
  expect(update.state.pending).toBe(false);
  expect(update.state.notice?.tone).toBe("warning");
  expect(update.state.notice?.text).toContain("Restart it manually");
  expect(update.state.notice?.text).toContain("Skipped git pull: dirty tree");
  jest.advanceTimersByTime(DISMISS_MS);
  flush();
  expect(update.state.notice?.text).toContain("Restart it manually");
  expect(sessionStorage.getItem(KEY)).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});

test("a note survives navigation and stays a success reporting the handshake, not the promised version", () => {
  const update = new Reload(URL, () => {});
  update.begin(TARGET);
  update.ingest({
    ...RESTARTING,
    to: "9.9.9",
    skipped: [{ label: "git pull", reason: "dirty tree", blocking: false }],
  });
  update.connection("reconnecting");
  update.connection("open");
  update.dispose();
  const fresh = new Reload(URL);
  fresh.ingest(ATTACHED);
  flush();
  expect(fresh.state.notice?.tone).toBe("success");
  expect(fresh.state.notice?.text).toContain("pim 1.2.3");
  expect(fresh.state.notice?.text).not.toContain("9.9.9");
  expect(fresh.state.notice?.text).toContain("Skipped git pull: dirty tree");
  jest.advanceTimersByTime(DISMISS_MS);
  flush();
  expect(fresh.state.notice).toBeUndefined();
});

test("a blocking skip warns and stays, because the update did less than it was asked", () => {
  const update = new Reload(URL, () => {});
  update.begin(TARGET);
  update.ingest({
    ...RESTARTING,
    to: "1.2.2",
    skipped: [
      { label: "install", reason: "the registry was silent", blocking: true },
    ],
  });
  update.connection("reconnecting");
  update.connection("open");
  update.dispose();
  const fresh = new Reload(URL);
  fresh.ingest(ATTACHED);
  jest.advanceTimersByTime(DISMISS_MS);
  flush();
  expect(fresh.state.notice?.tone).toBe("warning");
  expect(fresh.state.notice?.text).toContain(
    "Skipped install: the registry was silent"
  );
});

test("timeout clears intent, stops navigation, and is not extended by steps or page reloads", () => {
  const navigate = mock(() => {});
  const update = new Reload(URL, navigate);
  update.begin(TARGET);
  jest.advanceTimersByTime(170_000);
  update.ingest({
    type: "update_state",
    phase: "step",
    label: "still building",
  });
  update.dispose();
  const fresh = new Reload(URL, navigate);
  jest.advanceTimersByTime(10_000);
  flush();
  expect(fresh.state.pending).toBe(false);
  expect(fresh.state.notice?.text).toContain("timed out");
  expect(sessionStorage.getItem(KEY)).toBeNull();
  fresh.ingest(RESTARTING);
  fresh.connection("reconnecting");
  fresh.connection("open");
  expect(navigate).not.toHaveBeenCalled();
});

test("expired and malformed intents cannot turn an ordinary attach into success", () => {
  sessionStorage.setItem(
    KEY,
    JSON.stringify({
      deadline: Date.now() - 1,
      phase: "loaded",
      target: TARGET,
      skipped: "",
    })
  );
  const expired = new Reload(URL);
  expired.ingest(ATTACHED);
  flush();
  expect(expired.state.notice?.text).toContain("timed out");
  expect(sessionStorage.getItem(KEY)).toBeNull();
  sessionStorage.setItem(KEY, "not json");
  const malformed = new Reload(URL);
  malformed.ingest(ATTACHED);
  flush();
  expect(malformed.state.notice).toBeUndefined();
});

test("intent belongs to one server even with a shared browser origin", () => {
  const update = new Reload(URL);
  update.begin(TARGET);
  const other = new Reload("ws://127.0.0.1:4320");
  other.ingest(ATTACHED);
  flush();
  expect(other.state.pending).toBe(false);
  expect(other.state.notice).toBeUndefined();
  update.dispose();
});

test("denied storage does not prevent a live restart", () => {
  spyOn(sessionStorage, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  spyOn(sessionStorage, "removeItem").mockImplementation(() => {
    throw new Error("denied");
  });
  const navigate = mock(() => {});
  const update = new Reload(URL, navigate);
  update.begin(TARGET);
  update.ingest(RESTARTING);
  update.connection("reconnecting");
  update.connection("open");
  expect(navigate).toHaveBeenCalledTimes(1);
  update.dispose();
});

test("SessionStore sends a single sessionless command and surfaces refusals", async () => {
  const store = new SessionStore({ url: URL });
  const send = spyOn(store.client, "send").mockResolvedValue({
    type: "response",
    id: "1",
    success: false,
    error: "mid-turn",
  });
  await Promise.all([store.reload(true), store.reload(true)]);
  flush();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({ type: "reload", force: true });
  expect(store.update.state.pending).toBe(false);
  expect(store.update.state.notice?.text).toBe("mid-turn");
  expect(sessionStorage.getItem(KEY)).toBeNull();
  store.dispose();
});

test("a disconnected command reports its rejection without leaving restart intent", async () => {
  const store = new SessionStore({ url: URL });
  await store.reload();
  flush();
  expect(store.update.state.pending).toBe(false);
  expect(store.update.state.notice?.text).toBe("not connected");
  expect(sessionStorage.getItem(KEY)).toBeNull();
  store.dispose();
});

test("disposing cancels the timer but retains intent for the next page", () => {
  const update = new Reload(URL);
  update.begin(TARGET);
  update.dispose();
  jest.advanceTimersByTime(180_000);
  flush();
  expect(update.state.notice).toBeUndefined();
  expect(sessionStorage.getItem(KEY)).not.toBeNull();
});

test("the unloading document cannot time out and erase the next page's intent", () => {
  const update = new Reload(URL, () => {});
  update.begin(TARGET);
  update.ingest(RESTARTING);
  update.connection("reconnecting");
  update.connection("open");
  expect(update.begin(TARGET)).toBe(false);
  jest.advanceTimersByTime(180_000);
  flush();
  expect(update.state.notice).toBeUndefined();
  expect(sessionStorage.getItem(KEY)).not.toBeNull();
});
