import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { GatewayHarness, REPLY, until } from "../test/gateway";

let harness: GatewayHarness;
let stores: SessionStore[] = [];

function open(
  options: { readonly sessionId?: string; readonly cwd?: string } = {}
): SessionStore {
  const store = new SessionStore({
    url: harness.url,
    cwd: options.cwd ?? harness.tmp,
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    backoffMs: () => 20,
    pickerDebounceMs: 0,
  });
  stores.push(store);
  return store;
}

async function connect(
  options: { readonly sessionId?: string } = {}
): Promise<SessionStore> {
  const store = open(options);
  await store.connect();
  return store;
}

function idle(store: SessionStore): Promise<void> {
  return until(
    () => store.state.agent === "idle" && store.state.durable.length > 0,
    "the agent to settle"
  );
}

function seqs(events: readonly DurableEvent[]): readonly number[] {
  return events.map((event) => event.seq);
}

beforeEach(async () => {
  harness = new GatewayHarness();
  await harness.start();
});

afterEach(async () => {
  for (const store of stores) {
    store.dispose();
  }
  stores = [];
  await harness.stop();
});

test("streams a whole turn into the timeline", async () => {
  const store = await connect();
  expect(store.state.sessionId).toBeString();

  await store.prompt("say hello with a tool");
  await until(() => store.state.liveText !== "" || store.isBusy(), "streaming");
  await idle(store);

  const messages = store.state.durable.filter(
    (event) => event.type === "message"
  );
  expect(messages.map((m) => m.type === "message" && m.role)).toEqual([
    "user",
    "assistant",
    "assistant",
  ]);
  expect(
    messages.at(-1)?.type === "message" && messages.at(-1)?.type === "message"
  ).toBe(true);
  const final = messages.at(-1);
  expect(final?.type === "message" && final.text.trim()).toBe(REPLY);
  expect(
    store.state.durable.some((event) => event.type === "tool_result")
  ).toBe(true);
  // The in-flight bucket is emptied by the durable message that supersedes it.
  expect(store.state.liveText).toBe("");
  expect(store.state.liveTools).toEqual([]);
});

test("the optimistic echo is replaced by the durable user message", async () => {
  const store = await connect();

  const sent = store.prompt("say hello");
  // Store writes land on a microtask in Solid 2; `flush` is how a test sees
  // the echo at the instant the user would.
  flush();
  expect(store.state.optimistic.map((one) => one.text)).toEqual(["say hello"]);
  expect(
    store.timeline().filter((event) => event.type === "message")
  ).toHaveLength(1);
  await sent;

  await until(
    () => store.state.optimistic.length === 0,
    "the durable user message"
  );
  const users = store
    .timeline()
    .filter((event) => event.type === "message" && event.role === "user");
  expect(users).toHaveLength(1);
  expect(users[0]?.type === "message" && users[0].text).toBe("say hello");
});

test("in-flight tool rows merge with the durable ones on callId", async () => {
  const store = await connect();
  await store.prompt("use a tool please");
  await until(() => store.state.liveTools.length > 0, "a live tool call");

  const live = store.timeline();
  const calls = live.flatMap((event) =>
    event.type === "message" ? (event.toolCalls ?? []) : []
  );
  expect(new Set(calls.map((call) => call.callId)).size).toBe(calls.length);

  await idle(store);
  expect(store.state.liveTools).toEqual([]);
});

test("loses and duplicates nothing across a gateway restart", async () => {
  const store = await connect();
  const sessionId = store.state.sessionId;

  // One finished turn first, so the resume cursor under test is a real
  // ordinal rather than zero.
  await store.prompt("say hello");
  await idle(store);
  expect(store.client.seq).toBeGreaterThan(0);

  const release = harness.holdTurn();
  await store.prompt("say hello again");
  await until(() => store.state.liveText !== "", "the first delta");
  const before = [...store.state.durable];

  await harness.dropGateway();
  await until(
    () => store.state.connection === "reconnecting",
    "the client to notice"
  );
  harness.startGateway();
  await until(() => store.state.connection === "open", "the reconnect");
  release();
  await idle(store);

  const after = store.state.durable;
  expect(seqs(after)).toEqual([...new Set(seqs(after))]);
  expect(seqs(after)).toEqual([...seqs(after)].sort((a, b) => a - b));
  expect(after.slice(0, before.length)).toEqual(before);
  expect(store.state.sessionId).toBe(sessionId);

  const final = after.filter((event) => event.type === "message").at(-1);
  expect(final?.type === "message" && final.text.trim()).toBe(REPLY);

  // The proof that nothing was lost: a client that reads the log from the
  // start sees exactly what the reconnecting one accumulated.
  const fresh = await connect({ sessionId });
  await until(
    () => fresh.state.durable.length >= after.length,
    "the fresh replay"
  );
  expect(fresh.state.durable).toEqual(after);
});

test("re-attaching does not replay the in-flight text twice", async () => {
  const release = harness.holdTurn();
  const store = await connect();
  await store.prompt("say hello");
  await until(() => store.state.liveText.length > 5, "some streamed text");
  const partial = store.state.liveText;

  await harness.dropGateway();
  await until(() => store.state.connection === "reconnecting", "the drop");
  harness.startGateway();
  await until(() => store.state.connection === "open", "the reconnect");
  await until(() => store.state.liveText !== "", "the coalesced snapshot");

  expect(store.state.liveText.startsWith(partial)).toBe(true);
  expect(REPLY).toStartWith(store.state.liveText.trim());
  release();
  await idle(store);
});

test("a parked approval is answered, and the tool then runs", async () => {
  const store = await connect();
  await store.prompt("run a shell command");
  await until(() => store.state.approvals.length === 1, "an approval request");

  const request = store.state.approvals[0]!;
  expect(request.name).toBe("shell");
  expect(request.reason).toBeString();

  await store.approve(request.callId, true);
  await until(() => store.state.approvals.length === 0, "the request to clear");
  await idle(store);
  expect(await Bun.file(harness.marker).text()).toBe("echo hi");
});

test("a denied approval clears and the tool never runs", async () => {
  const store = await connect();
  await store.prompt("run a shell command");
  await until(() => store.state.approvals.length === 1, "an approval request");

  await store.approve(store.state.approvals[0]!.callId, false);
  await idle(store);

  expect(store.state.approvals).toEqual([]);
  expect(await Bun.file(harness.marker).exists()).toBe(false);
});

test("an approval parked with no client attached is shown on attach", async () => {
  const first = await connect();
  const sessionId = first.state.sessionId;
  await first.prompt("run a shell command");
  await until(() => first.state.approvals.length === 1, "the first request");
  first.dispose();

  const late = await connect({ sessionId });
  await until(
    () => late.state.approvals.length === 1,
    "the parked request on a fresh attach"
  );
  expect(late.state.approvals[0]?.name).toBe("shell");
});

test("the file picker is answered by the server and completes a token", async () => {
  await Bun.write(`${harness.tmp}/greeter.ts`, "export const x = 1;\n");
  const store = await connect();

  const items = await store.files.rank("greeter", { limit: 10 });
  expect(items?.length).toBeGreaterThan(0);
  expect(items?.[0]?.value).toContain("greeter.ts");

  // Nothing was ranked here: one query out, at most `limit` rows back.
  const direct = await store.pickFiles("greeter", 10);
  expect(direct.map((item) => item.value)).toEqual(
    (items ?? []).map((item) => item.value)
  );
});

test("switching sessions swaps the log and keeps the socket", async () => {
  const store = await connect();
  const first = store.state.sessionId;
  await store.prompt("say hello");
  await idle(store);
  const firstLog = [...store.state.durable];

  await store.newSession(harness.tmp);
  await until(
    () => store.state.sessionId !== "" && store.state.sessionId !== first,
    "a new session"
  );
  expect(store.state.durable).toEqual([]);
  expect(store.client.seq).toBe(0);
  const second = store.state.sessionId;

  // A session pi has not written a header for yet is not in the catalogue,
  // which is right: there is nothing there to resume.
  const listed = await store.listSessions();
  expect(listed.map((row) => row.sessionId)).toContain(first);
  expect(listed.every((row) => row.cwd === harness.tmp)).toBe(true);
  expect(second).not.toBe(first);

  await store.switchTo(first);
  await until(
    () => store.state.durable.length >= firstLog.length,
    "the first session's log"
  );
  expect(store.state.sessionId).toBe(first);
  expect(store.state.durable).toEqual(firstLog);
});

test("an upload never puts a client-local path in the conversation", async () => {
  const store = await connect();
  const stored = await store.upload(
    new File(["hello"], "notes.txt", { type: "text/plain" })
  );

  expect(stored.path.startsWith(harness.tmp)).toBe(false);
  expect(stored.id).toBeString();
  await store.prompt("look at this", [stored]);
  await until(
    () => store.state.durable.some((event) => event.type === "message"),
    "the durable user message"
  );

  const dump = JSON.stringify(store.state.durable);
  expect(dump).toContain(stored.path);
  expect(dump).not.toContain("notes.txt\u0000");
});
