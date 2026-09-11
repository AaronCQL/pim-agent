import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import readExtension from "#core/extensions/read/index";
import { Tools } from "#core/shared/Tools";
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

/** A one-pixel PNG as pi persists it: the string that must never reach a client. */
const BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SHA256 = "b".repeat(64);

const pi = { registerTool: () => {} } as unknown as ExtensionAPI;

/** A view that shows whatever content it is handed, so a leak would be visible in the frame. */
function registerMirror(): void {
  Tools.register(pi, {
    name: "mirror",
    label: "mirror",
    description: "test double",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [], details: undefined }),
    toViewModel: ({ result }) => ({
      title: [{ kind: "text", text: "mirror" }],
      body: (result?.content ?? []).map((part) => ({
        kind: "text" as const,
        text: part.type === "text" ? part.text : `<${part.type}>`,
      })),
    }),
  });
}

/** The pair of entries a `read` of a picture leaves in the session file. */
function imageRead(toolName: string): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: toolName,
          arguments: { path: "/work/shot.png" },
        },
      ],
      usage: {},
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName,
      isError: false,
      content: [
        { type: "text", text: "image resized from 4000x2000 to 2000x1000" },
        { type: "image", data: BASE64, mimeType: "image/png" },
      ],
      details: {
        kind: "image",
        absolutePath: "/work/shot.png",
        sha256: SHA256,
        mimeType: "image/png",
        width: 2000,
        height: 1000,
        bytes: 262144,
        resized: true,
      },
    },
  ];
}

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

/** A log holding an assistant message pi could not finish. */
async function deadTurn(
  message: Record<string, unknown>
): Promise<SessionProjection> {
  return logOf({ role: "assistant", content: [], usage: {}, ...message });
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

test("a turn the model killed carries why on the message it died on", async () => {
  const events = await (
    await deadTurn({
      stopReason: "error",
      errorMessage: "rate_limit_error: too many requests",
      content: [{ type: "text", text: "Let me check" }],
    })
  ).drain();

  expect(events).toEqual([
    {
      seq: 1,
      type: "message",
      messageId: "entry-0",
      role: "assistant",
      text: "Let me check",
      timestamp: Date.parse("2026-08-01T10:17:47.104Z"),
      error: "rate_limit_error: too many requests",
    },
  ]);
});

test("a failure the provider did not explain still says one happened", async () => {
  const events = await (await deadTurn({ stopReason: "error" })).drain();

  expect(events[0]?.type === "message" && events[0].error).toBe(
    "The model call failed."
  );
});

test("an abort is not an error: cancelling is not a failure", async () => {
  const events = await (
    await deadTurn({ stopReason: "aborted", errorMessage: "Aborted" })
  ).drain();

  expect(events[0]?.type === "message" && events[0].error).toBeUndefined();
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

test("image content is replaced before a view is built, so no base64 is emitted", async () => {
  registerMirror();
  const events = await (await logOf(...imageRead("mirror"))).drain();

  const result = events[1];
  expect(result?.type === "tool_result" && result.view.body).toEqual([
    { kind: "text", text: "image resized from 4000x2000 to 2000x1000" },
    { kind: "text", text: "[image]" },
  ]);
  expect(JSON.stringify(events)).not.toContain(BASE64);
});

test("a read of a picture crosses as the digest that addresses the cache", async () => {
  readExtension(pi);
  const events = await (await logOf(...imageRead("read"))).drain();

  const result = events[1];
  expect(result?.type === "tool_result" && result.view.body?.[0]).toEqual({
    kind: "image",
    sha256: SHA256,
    mimeType: "image/png",
    width: 2000,
    height: 1000,
    bytes: 262144,
    alt: "work/shot.png",
  });
  expect(JSON.stringify(events)).not.toContain(BASE64);
});
