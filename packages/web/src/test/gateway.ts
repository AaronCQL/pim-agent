import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

import { SessionRegistry } from "#core/session/SessionRegistry";
import type { ToolDiff } from "#core/shared/DiffLines";
import { SubagentLogs } from "#core/shared/SubagentLogs";
import { Tools, type PimToolDefinition } from "#core/shared/Tools";
import { WsGateway } from "#server/WsGateway";

export const REPLY = "hello from the gateway";
/** What the step that calls the tool reasons and says before calling it. */
export const REASONING = "a ping is what was asked for";
export const TOOL_PROSE = "Pinging now.";

/**
 * Paces the reply so a test that drops the socket mid-turn still finds the
 * step open. Load-bearing, unlike the equivalent in the gateway's own tests:
 * shrinking it makes "re-attaching does not replay the in-flight text twice"
 * reconnect to a session whose projection comes back empty.
 */
const TOKEN_DELAY_MS = 15;

/** Fine enough that polling is not itself the thing the tests are waiting on. */
const POLL_MS = 1;

const pingSchema = Type.Object({ text: Type.String() });

function pingTool(): PimToolDefinition<typeof pingSchema, { echoed: string }> {
  return {
    name: "ping",
    label: "ping",
    description: "echo a string back",
    parameters: pingSchema,
    effect: { kind: "readOnly" },
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: `pong: ${params.text}` }],
      details: { echoed: params.text },
    }),
    toViewModel: ({ args, result }) => ({
      label: "Ping",
      title: [{ kind: "text", text: args.text ?? "" }],
      ...(result === undefined
        ? {}
        : {
            summary: [
              {
                kind: "kv" as const,
                pairs: [["echoed", result.details.echoed] as const],
              },
            ],
          }),
    }),
  };
}

/** The parent's call id for the delegated run, so a watch can name it. */
export const SUBAGENT_CALL_ID = "call_sub";
/** The same, for the delegation that throws instead of answering. */
export const SUBAGENT_FAIL_CALL_ID = "call_sub_bad";
/** What the failing run throws, which is all the parent keeps of it. */
export const SUBAGENT_FAILURE = "child hit its step limit";
export const SUBAGENT_PROMPT = "find every call site of parseConfig";
/** What the child says once it has finished looking. */
export const SUBAGENT_ANSWER = "three of the nine are in tests";
/** The line the child's own tool call changed, which is the diff's point. */
export const CHILD_PATCH_LINE = "const port = 8080;";

const subagentSchema = Type.Object({ prompt: Type.String() });
const patchSchema = Type.Object({ path: Type.String() });

const CHILD_PATH = "src/config.ts";

const CHILD_DIFF: ToolDiff = {
  path: CHILD_PATH,
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        {
          kind: "context",
          oldLine: 1,
          newLine: 1,
          text: "export const app = {",
        },
        { kind: "removed", oldLine: 2, text: "const port = 80;" },
        { kind: "added", newLine: 2, text: CHILD_PATCH_LINE },
      ],
    },
  ],
};

/**
 * A tool the child calls and the parent never does. Registered for its view
 * alone: a watched transcript is projected in this process, so the diff a row
 * opens onto is painted by the same factory a real tool would register.
 */
function patchTool(): PimToolDefinition<
  typeof patchSchema,
  { diff: ToolDiff }
> {
  return {
    name: "patch",
    label: "patch",
    description: "edit a file",
    parameters: patchSchema,
    effect: { kind: "readOnly" },
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: `patched ${params.path}` }],
      details: { diff: CHILD_DIFF },
    }),
    toViewModel: ({ args, result }) => ({
      label: "Patch",
      title: [{ kind: "text", text: args?.path ?? "" }],
      ...(result === undefined
        ? {}
        : {
            body: [
              {
                kind: "diff" as const,
                path: args?.path ?? "",
                hunks: result.details.diff.hunks,
              },
            ],
          }),
    }),
  };
}

/**
 * A subagent, reduced to what a watch can see of one: a child session file
 * written where the server derives it from, and a progress report per entry —
 * which is the only signal the server gets that the child wrote anything.
 */
function subagentTool(
  gate: () => Promise<void> | undefined
): PimToolDefinition<typeof subagentSchema, { turns: number }> {
  return {
    name: "subagent",
    label: "subagent",
    description: "run a task in a subagent",
    parameters: subagentSchema,
    effect: { kind: "readOnly" },
    execute: async (callId, params, _signal, onUpdate, ctx) => {
      const log = await childLog(ctx.sessionManager.getSessionId(), callId);
      await log.say("user", params.prompt);
      onUpdate?.({
        content: [{ type: "text" as const, text: "working" }],
        details: { turns: 1 },
      });
      await gate();
      // A failure is thrown rather than returned, which is what makes it a
      // failure: pi keeps the message and drops the details, and the child log
      // written on the way down is what keeps the run readable at all.
      if (callId === SUBAGENT_FAIL_CALL_ID) {
        throw new Error(SUBAGENT_FAILURE);
      }
      await log.call("child_1", "patch", { path: CHILD_PATH });
      await log.answered("child_1", "patch", `patched ${CHILD_PATH}`);
      await log.say("assistant", SUBAGENT_ANSWER);
      const result = {
        content: [{ type: "text" as const, text: SUBAGENT_ANSWER }],
        details: { turns: 2 },
      };
      onUpdate?.(result);
      return result;
    },
    toViewModel: ({ args, result, isPartial }) => ({
      label: "Subagent",
      labelTone: isPartial ? "warning" : "accent",
      title: [{ kind: "markdown", text: args?.prompt ?? "" }],
      summary: [
        {
          kind: "spans",
          spans: [
            {
              text: `${result?.details.turns ?? 1} turns ⬝ $0.02`,
              tone: isPartial ? "warning" : "muted",
            },
          ],
        },
      ],
    }),
  };
}

/**
 * The child's session file, written by hand in pi's own JSONL: a real
 * subagent's log is pi appending to it, and what a watch reads is the file,
 * not the tool that filled it.
 */
async function childLog(
  parentSessionId: string | undefined,
  callId: string
): Promise<{
  readonly say: (role: string, text: string) => Promise<void>;
  readonly call: (id: string, name: string, args: unknown) => Promise<void>;
  readonly answered: (id: string, name: string, text: string) => Promise<void>;
}> {
  const path = await SubagentLogs.create(parentSessionId ?? "", callId);
  if (path === null) {
    throw new Error(`no child log for ${parentSessionId}/${callId}`);
  }
  const at = "2026-09-07T10:00:00.000Z";
  let entries = 0;
  const append = async (message: unknown): Promise<void> => {
    entries += 1;
    await appendFile(
      path,
      `${JSON.stringify({
        type: "message",
        id: `entry-${entries}`,
        parentId: null,
        timestamp: at,
        message,
      })}\n`
    );
  };
  await Bun.write(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: `${parentSessionId}-${callId}`,
      timestamp: at,
      cwd: "/repo",
    })}\n`
  );
  return {
    say: (role, text) => append({ role, content: [{ type: "text", text }] }),
    call: (id, name, args) =>
      append({
        role: "assistant",
        content: [
          { type: "text", text: "Patching it." },
          { type: "toolCall", id, name, arguments: args },
        ],
      }),
    answered: (id, name, text) =>
      append({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        isError: false,
        content: [{ type: "text", text }],
        details: { diff: CHILD_DIFF },
      }),
  };
}

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

type ChatBody = {
  readonly messages: readonly {
    readonly role: string;
    readonly content?: unknown;
  }[];
};

/** Which tool the prompt is asking for, if it is asking for one. */
function requestedTool(
  prompt: string
):
  | { readonly callId: string; readonly name: string; readonly args: unknown }
  | undefined {
  if (prompt.includes("delegate")) {
    return {
      callId: prompt.includes("badly")
        ? SUBAGENT_FAIL_CALL_ID
        : SUBAGENT_CALL_ID,
      name: "subagent",
      args: { prompt: SUBAGENT_PROMPT },
    };
  }
  return prompt.includes("tool")
    ? { callId: "call_1", name: "ping", args: { text: "hi" } }
    : undefined;
}

function lastUserText(body: ChatBody): string {
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message?.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return (message.content as readonly Record<string, unknown>[])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
    }
  }
  return "";
}

/**
 * A real gateway over a real session, with a stub model server standing in for
 * the provider. The web client is driven against this rather than a mocked
 * socket, so what the tests prove is the wire, not a fixture of it.
 *
 * The stub reads the prompt: "tool" asks for the one registered tool, and
 * anything else streams prose a word at a time.
 */
export class GatewayHarness {
  public tmp = "";
  public registry!: SessionRegistry;
  public gateway!: WsGateway;
  private modelServer: ReturnType<typeof Bun.serve> | undefined;
  private previousAgentDir: string | undefined;
  private previousPimHome: string | undefined;
  private agentDir = "";
  private port = 0;
  /** Held open by a test that wants the turn to still be in flight. */
  private gate: Promise<void> | undefined;

  public get url(): string {
    return this.gateway.url;
  }

  /**
   * How many messages pi is actually holding behind the turn in flight.
   *
   * `user_message` is acked when the gateway accepts it, not when the agent
   * has queued it — deliberately, since a turn has to outlive the connection
   * that asked for it. So the row a client paints on that ack is optimistic
   * and says nothing about pi, and a test that means to reclaim the queue has
   * to wait for this instead.
   */
  public pending(sessionId: string): number {
    return (
      this.registry.peek(sessionId)?.agentSession?.pendingMessageCount ?? 0
    );
  }

  public async start(): Promise<void> {
    this.tmp = await mkdtemp(join(tmpdir(), "pim-web-test-"));
    this.agentDir = join(this.tmp, "agent");
    await mkdir(join(this.agentDir, "extensions"), { recursive: true });
    this.previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = this.agentDir;
    // A subagent's log is derived under this root, so a test run must never
    // write into the developer's own ~/.pim/subagents.
    this.previousPimHome = process.env.PIM_HOME_DIR;
    process.env.PIM_HOME_DIR = join(this.tmp, "pim");
    this.startModelServer();
    await Bun.write(
      join(this.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            baseUrl: `http://localhost:${this.modelServer?.port}/v1`,
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: "echo", maxTokens: 1024, contextWindow: 8192 }],
          },
        },
      })
    );
    this.registry = new SessionRegistry({
      defaults: { cwd: this.tmp, model: "test/echo" },
      agentDir: this.agentDir,
      customTools: () =>
        [
          Tools.wrap(pingTool()),
          Tools.wrap(subagentTool(() => this.gate)),
          Tools.wrap(patchTool()),
        ] as unknown as ToolDefinition[],
    });
    await this.registry.init();
    this.startGateway();
  }

  /** Stops listening without touching the sessions; the agent keeps running. */
  public async dropGateway(): Promise<void> {
    await this.gateway.stop();
  }

  /** Comes back on the same port, so a reconnecting client finds it again. */
  public startGateway(): void {
    this.gateway = new WsGateway({ registry: this.registry, port: this.port });
    this.gateway.start();
    this.port = this.gateway.port;
  }

  public holdTurn(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = undefined;
      release();
    };
  }

  public async stop(): Promise<void> {
    await this.gateway.stop();
    await this.registry.disposeAll();
    await this.modelServer?.stop(true);
    this.modelServer = undefined;
    for (const [name, previous] of [
      ["PI_CODING_AGENT_DIR", this.previousAgentDir],
      ["PIM_HOME_DIR", this.previousPimHome],
    ] as const) {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
    await rm(this.tmp, { recursive: true, force: true });
  }

  private startModelServer(): void {
    this.modelServer = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        const body = (await req.json()) as ChatBody;
        const prompt = lastUserText(body);
        const answered = body.messages.at(-1)?.role === "tool";
        const tool = answered ? undefined : requestedTool(prompt);
        const gate = this.gate;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encode = (text: string) =>
              controller.enqueue(Buffer.from(text));
            encode(chunk({ role: "assistant", content: "" }));
            if (tool) {
              for (const word of REASONING.split(" ")) {
                encode(chunk({ reasoning_content: `${word} ` }));
              }
              for (const word of TOOL_PROSE.split(" ")) {
                encode(chunk({ content: `${word} ` }));
              }
              encode(
                chunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: tool.callId,
                      type: "function",
                      function: {
                        name: tool.name,
                        arguments: JSON.stringify(tool.args),
                      },
                    },
                  ],
                })
              );
              encode(chunk({}, "tool_calls"));
            } else {
              for (const word of REPLY.split(" ")) {
                encode(chunk({ content: `${word} ` }));
                await Bun.sleep(TOKEN_DELAY_MS);
              }
              await gate;
              encode(chunk({}, "stop"));
            }
            encode("data: [DONE]\n\n");
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
  }
}

/**
 * Polls until `test` holds; the store is a reactive object, not an emitter.
 *
 * The default has to stay under bun's own 5s per-test timeout, or the runner
 * kills the test first and the verdict is a bare "timed out after 5000ms"
 * with no clue which wait hung — which is exactly the diagnostic this label
 * exists to give.
 */
export async function until(
  test: () => boolean,
  label: string,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await Bun.sleep(POLL_MS);
  }
}
