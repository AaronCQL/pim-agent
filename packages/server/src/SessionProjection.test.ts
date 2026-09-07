import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";

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

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

/** A log holding exactly the messages a test needs, one entry per message. */
async function logOf(
  ...messages: ReadonlyArray<Record<string, unknown>>
): Promise<SessionProjection> {
  tmp = await mkdtemp(join(tmpdir(), "pim-projection-test-"));
  const path = join(tmp, "session.jsonl");
  await Bun.write(
    path,
    messages
      .map((message, index) =>
        JSON.stringify({
          type: "message",
          id: `entry-${index}`,
          timestamp: "2026-08-01T10:17:47.104Z",
          message,
        })
      )
      .map((line) => `${line}\n`)
      .join("")
  );
  return new SessionProjection(path, () => "/");
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

test("a failed call carries why, not a view of the result it never got", async () => {
  const events = await (
    await logOf(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "apply_patch",
            arguments: { input: "*** Begin Patch" },
          },
        ],
        usage: {},
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "apply_patch",
        isError: true,
        content: [{ type: "text", text: "No files were modified." }],
        // Pi's error result is synthetic: the message is all it carries.
        details: {},
      }
    )
  ).drain();

  const result = events[1];
  expect(result?.type === "tool_result" && result.isError).toBe(true);
  expect(result?.type === "tool_result" && result.view.body).toEqual([
    { kind: "notice", severity: "error", text: "No files were modified." },
  ]);
});
