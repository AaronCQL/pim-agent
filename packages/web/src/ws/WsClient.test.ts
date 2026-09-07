import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { toRows } from "../transcript/rows";
import {
  GatewayHarness,
  REASONING,
  REPLY,
  TOOL_PROSE,
  until,
} from "../test/gateway";

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

/** Everything the live bucket has streamed, in order, as one string. */
function liveText(store: SessionStore): string {
  return store.state.live.map((message) => message.text).join("");
}

function liveTools(store: SessionStore) {
  return store.state.live.flatMap((message) => message.tools);
}

test("streams a whole turn into the timeline", async () => {
  const store = await connect();
  expect(store.state.sessionId).toBeString();

  await store.prompt("say hello with a tool");
  await until(() => liveText(store) !== "" || store.isBusy(), "streaming");
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
  expect(store.state.live).toEqual([]);
});

test("the optimistic echo is replaced by the durable user message", async () => {
  const store = await connect();

  const sent = store.prompt("say hello");
  // Store writes land on a microtask in Solid 2; `flush` is how a test sees
  // the echo at the instant the user would.
  flush();
  expect(store.state.optimistic.map((one) => one.text)).toEqual(["say hello"]);
  expect(store.trailing()).toHaveLength(1);
  await sent;

  await until(
    () => store.state.optimistic.length === 0,
    "the durable user message"
  );
  const users = store.state.durable.filter(
    (event) => event.type === "message" && event.role === "user"
  );
  expect(users).toHaveLength(1);
  expect(users[0]?.type === "message" && users[0].text).toBe("say hello");
});

/**
 * What pi is holding for the turn, straight off the session behind the wire.
 *
 * Only ever stable while the turn is parked mid stream, which is why the
 * tests that read it open with a prompt that asks for no tool. pi hands this
 * queue to the turn at a turn boundary and a tool result is one, so a steer
 * queued across a tool call can be observed here and then delivered a moment
 * later — leaving nothing to take back, and failing whichever assertion came
 * second.
 */
function queuedOn(store: SessionStore): readonly string[] {
  const agent = harness.registry.peek(store.state.sessionId)?.agentSession;
  return [
    ...(agent?.getSteeringMessages() ?? []),
    ...(agent?.getFollowUpMessages() ?? []),
  ];
}

/**
 * The rows this client is holding for the running turn: what the reader can
 * still take back.
 *
 * Not the whole of `trailing()`, which also holds the message that opened the
 * turn until its durable echo lands — an unqueued row, cleared by the server
 * rather than by anything a steer does, and on its own schedule. Asserting on
 * the bucket entire makes every test below race that echo for a row none of
 * them are about.
 */
function heldBack(store: SessionStore): readonly string[] {
  return store
    .trailing()
    .filter((one) => one.queued === true)
    .map((one) => one.text);
}

test("a message typed into a running turn steers it", async () => {
  const store = await connect();
  const release = harness.holdTurn();
  await store.prompt("hold this turn open");
  await until(() => store.isBusy(), "the turn to start");

  await store.prompt("and mention the weather");
  flush();
  // The steer is drawn as said-but-unheard the moment it is typed. The wire
  // agrees: pi is holding it for the turn in flight rather than for the next.
  expect(heldBack(store)).toEqual(["and mention the weather"]);
  await until(() => queuedOn(store).length === 1, "pi to queue the steer");
  expect(queuedOn(store)).toEqual(["and mention the weather"]);

  // A second one does not queue behind the first: both sides join them into
  // the one message the reader can still take back whole.
  await store.prompt("and the tide");
  await until(
    () => queuedOn(store)[0]?.includes("tide") === true,
    "the second message to join the first"
  );
  flush();
  expect(queuedOn(store)).toEqual(["and mention the weather\n\nand the tide"]);
  expect(heldBack(store)).toEqual(["and mention the weather\n\nand the tide"]);

  release();
  await until(
    () =>
      store.state.durable.filter(
        (event) => event.type === "message" && event.role === "user"
      ).length === 2,
    "both messages to reach the log"
  );
  expect(store.state.optimistic).toEqual([]);
});

test("stopping hands the queued message back to the box it came from", async () => {
  const store = await connect();
  const release = harness.holdTurn();
  await store.prompt("hold this turn open");
  await until(() => store.isBusy(), "the turn to start");
  await store.prompt("never mind");
  await until(() => queuedOn(store).length === 1, "pi to queue the steer");

  const restored = await store.cancel();
  release();

  expect(restored).toBe("never mind");
  flush();
  // It was never said, so it leaves the transcript rather than sitting there
  // forever waiting for an echo that is never coming.
  expect(store.state.optimistic.map((one) => one.text)).not.toContain(
    "never mind"
  );
});

test("taking the queued message back leaves the turn running", async () => {
  const store = await connect();
  const release = harness.holdTurn();
  await store.prompt("hold this turn open");
  await until(() => store.isBusy(), "the turn to start");
  await store.prompt("on second thoughts");
  await until(() => queuedOn(store).length === 1, "pi to queue the steer");

  const restored = await store.dequeue();

  expect(restored).toBe("on second thoughts");
  // Unlike a stop: the reader is editing what they said, not calling the
  // agent off the work it is doing.
  expect(store.isBusy()).toBe(true);
  expect(queuedOn(store)).toEqual([]);
  flush();
  // The steer is gone from the transcript too. The message that opened the
  // turn is not: taking a steer back is not a reason to unpaint it.
  expect(heldBack(store)).toEqual([]);
  release();
});

/** The ids of every tool row the transcript would draw, live and durable. */
function toolRows(store: SessionStore): readonly string[] {
  return toRows(store.state.durable, store.trailing(), store.state.live)
    .filter((row) => row.kind === "tool")
    .map((row) => row.id);
}

test("in-flight tool rows merge with the durable ones on callId", async () => {
  const store = await connect();
  await store.prompt("use a tool please");
  // A call is sighted three times — as the step's `toolCalls`, as its own
  // `tool_result`, and in the live bucket while it runs — and any two of
  // those may be on screen at once.
  await until(() => toolRows(store).length > 0, "a tool row");
  expect(new Set(toolRows(store)).size).toBe(toolRows(store).length);

  await idle(store);
  expect(store.state.live).toEqual([]);
  expect(toolRows(store)).toHaveLength(1);
});

test("a finished step goes durable while the next one is still live", async () => {
  const store = await connect();
  const release = harness.holdTurn();
  await store.prompt("use a tool please");
  await until(
    () => liveText(store).trim() === REPLY.split(" ")[0],
    "the second step to start streaming"
  );

  // Pi wrote the tool step the moment it ended, so it is a durable row and
  // not a live one: only the step still being streamed is in the bucket, or
  // the transcript would hold both and draw the prose twice.
  const [step] = store.state.durable.filter(
    (event) => event.type === "message" && event.role === "assistant"
  );
  expect(step?.type === "message" && step.text.trim()).toBe(TOOL_PROSE);
  expect(step?.type === "message" && step.thinking?.trim()).toBe(REASONING);
  expect(step?.type === "message" && step.toolCalls?.length).toBe(1);
  // Prose, rather than the bucket's length: a retired step whose result is
  // drained in the same batch as its own durable copy leaves an empty shell
  // behind — one that draws no row and goes when the turn settles. What must
  // never happen is the finished step's words being in both places at once.
  expect(
    store.state.live.filter((message) => message.text !== "")
  ).toHaveLength(1);
  // The call stopped spinning on the frame that ended it: the client does not
  // wait for pi to append the result before the row settles.
  expect(liveTools(store).some((tool) => tool.isPartial)).toBe(false);

  release();
  await idle(store);
  // Every step is durable now, so nothing is left live to draw twice.
  expect(store.state.live).toEqual([]);
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
  await until(() => liveText(store) !== "", "the first delta");
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
  // The prompt takes two steps and only the second one is held open, so the
  // drop has to land in it: a prefix of `REPLY` is what says we are there,
  // where "some text arrived" would also match the tool step's prose.
  await until(() => {
    const text = liveText(store).trim();
    return text.length > 0 && REPLY.startsWith(text);
  }, "the held step to start streaming");
  const partial = liveText(store);

  await harness.dropGateway();
  await until(() => store.state.connection === "reconnecting", "the drop");
  harness.startGateway();
  await until(() => store.state.connection === "open", "the reconnect");
  await until(() => liveText(store) !== "", "the coalesced snapshot");

  expect(liveText(store).startsWith(partial)).toBe(true);
  expect(REPLY).toStartWith(liveText(store).trim());
  release();
  await idle(store);
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

test("a turn is marked on the list of a client that is reading elsewhere", async () => {
  const worker = await connect();
  const sessionId = worker.state.sessionId;
  await worker.prompt("say hello");
  await idle(worker);

  const watcher = await connect();
  expect(watcher.state.sessionId).not.toBe(sessionId);
  // Where a client that has just loaded learns about a session it has never
  // been attached to: the catalogue, once.
  await watcher.listSessions();
  expect(watcher.isRunning(sessionId)).toBe(false);

  const release = harness.holdTurn();
  await worker.prompt("say hello again");
  await until(() => watcher.isRunning(sessionId), "the other session to work");
  release();
  await until(() => !watcher.isRunning(sessionId), "the other session to stop");
});

test("an upload reaches the transcript as a file, not as a path", async () => {
  const store = await connect();
  const stored = await store.attachFile(
    new File(["hello"], "notes.txt", { type: "text/plain" })
  );

  expect(stored.url).toStartWith("http");
  expect(store.attachmentsOf(store.state.sessionId)).toEqual([stored]);
  await store.prompt("look at this");
  await until(
    () => store.state.durable.some((event) => event.type === "message"),
    "the durable user message"
  );

  const said = store.state.durable.find(
    (event) => event.type === "message" && event.role === "user"
  );
  // The marker the agent was told about is the server's path to the bytes,
  // and neither half of it belongs on screen.
  expect(said?.type === "message" && said.text).toBe("look at this");
  expect(said?.type === "message" && said.attachments).toEqual([
    { name: "notes.txt", url: stored.url, isImage: false },
  ]);
  expect(JSON.stringify(store.state.durable)).not.toContain(harness.tmp);
  // The row is empty once it is sent: the server is holding those bytes for
  // a message that has gone.
  expect(store.attachmentsOf(store.state.sessionId)).toEqual([]);

  const fetched = await fetch(stored.url);
  expect(await fetched.text()).toBe("hello");
});

test("the model catalogue is asked for once and switching it lands on state", async () => {
  const store = await connect();

  const first = await store.listModels();
  expect(first.models).toEqual([
    { id: "test/echo", label: "echo", provider: "test" },
  ]);
  expect(first.thinkingLevels).toBeArray();
  // Cached for the connection: the catalogue is a property of the machine.
  expect(await store.listModels()).toBe(first);

  await store.setModel("test/echo");
  await until(() => store.state.model === "test/echo", "the model on state");
});

test("a new chat is the browser's alone until pi writes its first line", async () => {
  const store = await connect();
  const first = store.state.sessionId;
  // The session a fresh tab is given is a new chat like any other: nothing
  // has been written to it, so nothing but this browser knows it exists —
  // and with an empty composer there is nothing to draw a row with either.
  expect(store.unwrittenSummary()).toBeUndefined();
  expect(
    (await store.listSessions()).map((row) => row.sessionId)
  ).not.toContain(first);

  store.setDraftText("say hello");
  flush();
  expect(store.unwrittenSummary()).toEqual({
    sessionId: first,
    cwd: harness.tmp,
  });
  expect(store.localTitle(first)).toBe("say hello");

  // Asking for a new chat while holding one is a request to go back to it.
  await store.newSession(harness.tmp);
  expect(store.state.sessionId).toBe(first);

  await store.prompt("say hello");
  flush();
  // Sent: the box is empty and the row keeps its place, named by the message
  // that went out, for as long as the directory cannot answer for it.
  expect(store.draftText(first)).toBe("");
  expect(store.unwrittenSummary()).toEqual({
    sessionId: first,
    cwd: harness.tmp,
  });
  expect(store.localTitle(first)).toBe("say hello");
  await idle(store);

  const listed = await store.listSessions();
  flush();
  expect(listed.map((row) => row.sessionId)).toContain(first);
  // A second row for a session the listing has would be the same
  // conversation twice.
  expect(store.unwrittenSummary()).toBeUndefined();
  // And it is still named by its opening message: the listing answers for it
  // now, but the name does not flicker back to an id while pi is mid-turn.
  expect(listed.find((row) => row.sessionId === first)?.title).toBe(
    "say hello"
  );

  // A conversation, so a new chat is a new session now.
  await store.newSession(harness.tmp);
  await until(() => store.state.sessionId !== first, "a second session");
  expect(store.state.unwritten?.sessionId).toBe(store.state.sessionId);
});

test("a session sent to and left keeps its name against the real listing", async () => {
  const store = await connect();
  const first = store.state.sessionId;

  await store.prompt("say hello");
  flush();
  // Straight into another chat, without waiting for the reply. Everything
  // that could name the first session is now somewhere else: the transcript
  // holds the session being read, the unwritten record holds the new one,
  // and pi has not been given long enough to have a log worth scanning.
  await store.newSession(harness.tmp);
  await until(() => store.state.sessionId !== first, "a second session");
  flush();

  const listed = await store.listSessions();
  flush();
  // Exactly what the sidebar paints, in the order it asks the questions.
  const row = listed.find((entry) => entry.sessionId === first);
  expect(row?.title ?? store.localTitle(first)).toBe("say hello");
});
