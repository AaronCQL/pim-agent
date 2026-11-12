import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import readExtension from "#core/extensions/read/index";
import {
  subagentNoticeView,
  subagentResultView,
} from "#core/extensions/subagent/render";
import { SubagentNotice } from "#core/extensions/subagent/SubagentNotice";
import { SubagentResult } from "#core/extensions/subagent/SubagentResult";
import { SubagentLogs } from "#core/shared/SubagentLogs";
import { Tools } from "#core/shared/Tools";
import type { DurableEvent } from "#protocol/ServerEvent";
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

/** A one-pixel PNG; must never reach a client. */
const BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SHA256 = "b".repeat(64);

const pi = { registerTool: () => {} } as unknown as ExtensionAPI;

/** Paints whatever content it gets, so a leak shows up in the view. */
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

/** Each entry gets an id and timestamp. */
async function entriesOf(
  ...entries: ReadonlyArray<Record<string, unknown>>
): Promise<SessionProjection> {
  tmp = await mkdtemp(join(tmpdir(), "pim-projection-test-"));
  const path = join(tmp, "session.jsonl");
  await Bun.write(
    path,
    entries
      .map((entry, index) =>
        JSON.stringify({
          id: `entry-${index}`,
          timestamp: "2026-08-01T10:17:47.104Z",
          ...entry,
        })
      )
      .map((line) => `${line}\n`)
      .join("")
  );
  return new SessionProjection(path, () => "/");
}

function logOf(
  ...messages: ReadonlyArray<Record<string, unknown>>
): Promise<SessionProjection> {
  return entriesOf(
    ...messages.map((message) => ({ type: "message", message }))
  );
}

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

  const call = events[1];
  const toolCalls = call?.type === "message" ? call.toolCalls : undefined;
  expect(toolCalls?.map(({ callId, name }) => ({ callId, name }))).toEqual([
    { callId: "toolu_01TJKxgX2GAeaDnSisokaAer", name: "subagent" },
  ]);
  expect(toolCalls?.[0]?.view.title).toBeArray();

  const result = events[2];
  expect(result?.type === "tool_result" && result.isError).toBe(false);
  expect(JSON.stringify(events)).not.toContain('"type":"text"');

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

test.each([
  [
    "an unexplained error gets a fallback",
    { stopReason: "error" },
    "The model call failed.",
  ],
  [
    "an abort is not an error",
    { stopReason: "aborted", errorMessage: "Aborted" },
    undefined,
  ],
])("%s", async (_name, message, error) => {
  const events = await (await deadTurn(message)).drain();

  expect(events[0]?.type === "message" && events[0].error).toBe(error);
});

test("a skill pi expanded crosses as the command typed, its markdown set apart", async () => {
  const events = await (
    await logOf({
      role: "user",
      content: [
        {
          type: "text",
          text: '<skill name="release" location="/s/SKILL.md">\n# Release\n</skill>\n\ncut it',
        },
      ],
    })
  ).drain();

  expect(events).toEqual([
    {
      seq: 1,
      type: "message",
      messageId: "entry-0",
      role: "user",
      text: "/skill:release cut it",
      timestamp: Date.parse("2026-08-01T10:17:47.104Z"),
      skill: { name: "release", content: "# Release" },
    },
  ]);
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

test("a job's result crosses as its own row, painted like a subagent run and keyed to its child log", async () => {
  const result = await SubagentResult.fromLog(
    {
      jobId: "call_job",
      handle: "j1",
      prompt: "audit the parser",
    },
    "/missing/child.jsonl"
  );
  const p = await entriesOf({ type: "custom_message", ...result });

  expect(await p.drain()).toEqual([
    {
      seq: 1,
      type: "subagent_result",
      messageId: "entry-0",
      jobId: "call_job",
      handle: "j1",
      state: "interrupted",
      view: subagentResultView(result),
      timestamp: Date.parse("2026-08-01T10:17:47.104Z"),
    },
  ]);
});

test("a job's context notice crosses as a subagent row linked to its job, never as a result", async () => {
  const notice = SubagentNotice.of(
    {
      jobId: "call_job",
      handle: "j22",
      contextTokens: 402_000,
      contextWindow: 1_000_000,
      turns: 69,
      cost: 9.8,
      elapsedMs: 30 * 60_000,
    },
    [{ title: "bash zig build test", state: "done" }]
  );
  const p = await entriesOf({ type: "custom_message", ...notice });

  expect(await p.drain()).toEqual([
    {
      seq: 1,
      type: "subagent_notice",
      messageId: "entry-0",
      jobId: "call_job",
      handle: "j22",
      view: subagentNoticeView(notice.details),
    },
  ]);
});

test("a call links the child log it owns: a spawn its job, a run the log it wrote, a failed spawn and the other actions nothing", async () => {
  const previousHome = process.env.PIM_HOME_DIR;
  const calls = {
    call_spawn: { action: "spawn", prompt: "audit" },
    call_failed: { action: "spawn", prompt: "audit" },
    call_run: { prompt: "audit" },
    call_broke: { prompt: "audit" },
    call_status: { action: "status", id: "j2" },
    call_open: { action: "spawn", prompt: "audit" },
  };
  const settled = (
    callId: keyof typeof calls,
    details: unknown,
    isError = false
  ): Record<string, unknown> => ({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "subagent",
      isError,
      content: [{ type: "text", text: isError ? "boom" : "ok" }],
      details,
    },
  });
  const p = await entriesOf(
    {
      type: "message",
      message: {
        role: "assistant",
        content: Object.entries(calls).map(([id, args]) => ({
          type: "toolCall",
          id,
          name: "subagent",
          arguments: args,
        })),
        usage: {},
      },
    },
    settled("call_spawn", {
      action: "spawn",
      jobId: "call_spawn",
      handle: "j2",
      prompt: "audit",
      owner: { pid: 1, hostname: "box" },
    }),
    settled("call_failed", {}, true),
    settled("call_run", {
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
        contextTokens: 10,
      },
    }),
    settled("call_broke", {}, true),
    settled("call_status", { action: "status", jobs: [] })
  );
  try {
    process.env.PIM_HOME_DIR = tmp;
    await SubagentLogs.create("parent", "call_run");
    await SubagentLogs.create("parent", "call_broke");
    const linked = new SessionProjection(
      join(tmp!, "session.jsonl"),
      () => "/",
      "parent"
    );
    const events = await linked.drain();
    const children = (event: DurableEvent | undefined) =>
      event?.type === "message"
        ? (event.toolCalls ?? []).map((call) => [call.callId, call.child])
        : event?.type === "tool_result"
          ? [[event.callId, event.child]]
          : [];

    expect(children(events[0])).toEqual([
      ["call_spawn", { jobId: "call_spawn" }],
      ["call_failed", { jobId: "call_failed" }],
      ["call_run", { jobId: "call_run" }],
      ["call_broke", { jobId: "call_broke" }],
      ["call_status", undefined],
      ["call_open", { jobId: "call_open" }],
    ]);
    expect(events.slice(1).flatMap(children)).toEqual([
      ["call_spawn", { jobId: "call_spawn", handle: "j2" }],
      ["call_failed", undefined],
      ["call_run", { jobId: "call_run" }],
      ["call_broke", { jobId: "call_broke" }],
      ["call_status", undefined],
    ]);
    expect(
      (await p.drain())
        .slice(1)
        .flatMap(children)
        .map(([, child]) => child)
    ).toEqual([
      { jobId: "call_spawn", handle: "j2" },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.PIM_HOME_DIR;
    } else {
      process.env.PIM_HOME_DIR = previousHome;
    }
  }
});

test("other custom messages, and a result or notice with no job, project nothing", async () => {
  const p = await entriesOf(
    {
      type: "custom_message",
      customType: "datetime",
      content: "Sunday",
      display: false,
    },
    {
      type: "custom_message",
      customType: SubagentResult.CUSTOM_TYPE,
      content: "[subagent job ? done]",
      display: true,
    },
    {
      type: "custom_message",
      customType: SubagentNotice.CUSTOM_TYPE,
      content: "[subagent job ? at 40% context, still running]",
      display: true,
      details: { jobId: "call_job" },
    }
  );

  expect(await p.drain()).toEqual([]);
  expect(p.head).toBe(3);
});
