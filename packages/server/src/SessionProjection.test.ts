import { join } from "node:path";
import { expect, test } from "bun:test";

import { SessionProjection } from "./SessionProjection";

const FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "core",
  "src",
  "session",
  "fixtures",
  "pi-session-v3.jsonl"
);

function projection(): SessionProjection {
  return new SessionProjection(FIXTURE, () => "/home/htpc/Desktop/dev/mmorpg");
}

test("projects a persisted session into durable events, one per line", async () => {
  const events = await projection().drain();

  expect(
    events.map((event) => [
      event.seq,
      event.type,
      "role" in event ? event.role : "",
    ])
  ).toEqual([
    [4, "message", "user"],
    [5, "message", "assistant"],
    [6, "tool_result", ""],
    [7, "message", "assistant"],
  ]);

  // The view itself depends on which extensions registered one, so assert the
  // wiring rather than a particular tool's painting.
  const call = events[1];
  const toolCalls = call?.type === "message" ? call.toolCalls : undefined;
  expect(toolCalls?.map(({ callId, name }) => ({ callId, name }))).toEqual([
    { callId: "toolu_01TJKxgX2GAeaDnSisokaAer", name: "subagent" },
  ]);
  expect(toolCalls?.[0]?.view.title).toBeArray();

  const result = events[2];
  expect(result?.type === "tool_result" && result.isError).toBe(false);
  expect(JSON.stringify(events)).not.toContain('"content"');

  // The stamp is pi's own, read off the entry: it is what the client's clock
  // line and its "Clanked for" reading are derived from after a reload.
  const first = events[0];
  expect(first?.type === "message" && first.timestamp).toBe(
    Date.parse("2026-08-01T10:17:47.104Z")
  );
});

test("replays only what a cursor has not seen, and drains once", async () => {
  const p = projection();
  await p.drain();

  expect(p.head).toBe(7);
  expect(p.since(5).map((event) => event.seq)).toEqual([6, 7]);
  expect(p.since(7)).toEqual([]);
  expect(await p.drain()).toEqual([]);
});

test("an unwritten session file projects nothing", async () => {
  const p = new SessionProjection(
    join(import.meta.dir, "nope.jsonl"),
    () => "/"
  );

  expect(await p.drain()).toEqual([]);
  expect(p.head).toBe(0);
});
