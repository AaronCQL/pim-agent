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
export const REASONING = "a ping is what was asked for";
export const TOOL_PROSE = "Pinging now.";

// Load-bearing: shrinking it makes the mid-turn reconnect test project an empty session.
const TOKEN_DELAY_MS = 15;

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

export const SUBAGENT_CALL_ID = "call_sub";
export const SUBAGENT_FAIL_CALL_ID = "call_sub_bad";
export const SUBAGENT_FAILURE = "child hit its step limit";
export const SUBAGENT_PROMPT = "find every call site of parseConfig";
export const SUBAGENT_ANSWER = "three of the nine are in tests";
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
      // Thrown, not returned: pi keeps the message and drops the details.
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

/** A real gateway over a real session, with a stub model server for the provider. */
export class GatewayHarness {
  public tmp = "";
  public registry!: SessionRegistry;
  public gateway!: WsGateway;
  private modelServer: ReturnType<typeof Bun.serve> | undefined;
  private previousAgentDir: string | undefined;
  private previousPimHome: string | undefined;
  private agentDir = "";
  private port = 0;
  private gate: Promise<void> | undefined;

  public get url(): string {
    return this.gateway.url;
  }

  /** How many messages pi holds behind the turn; the `user_message` ack does not say. */
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
    // A subagent's log derives under this root; never the developer's ~/.pim.
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
 * Polls until `test` holds. The default stays under bun's own 5s per-test
 * timeout, so a hung wait is named by `label` rather than killed by the runner.
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
