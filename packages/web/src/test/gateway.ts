import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

import { SessionRegistry } from "../../../core/src/session/SessionRegistry";
import { Tools, type PimToolDefinition } from "../../../core/src/shared/Tools";
import { WsGateway } from "../../../server/src/WsGateway";

export const REPLY = "hello from the gateway";

const pingSchema = Type.Object({ text: Type.String() });
const shellSchema = Type.Object({ command: Type.String() });

/** Tier 1: declared read-only, so the router never asks anybody. */
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

/** Tier 3: unbounded, so the turn parks until a client answers. */
function shellTool(
  marker: () => string
): PimToolDefinition<typeof shellSchema, { ran: string }> {
  return {
    name: "shell",
    label: "shell",
    description: "run a command",
    parameters: shellSchema,
    effect: { kind: "unbounded" },
    execute: async (_id, params) => {
      await Bun.write(marker(), params.command);
      return {
        content: [{ type: "text" as const, text: `ran ${params.command}` }],
        details: { ran: params.command },
      };
    },
    toViewModel: ({ args }) => ({
      label: "Shell",
      title: [{ kind: "text", text: args.command ?? "" }],
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
 * The stub reads the prompt: "shell" asks for the unbounded tool (tier 3,
 * parks), "tool" asks for the read-only one (tier 1, runs unattended), and
 * anything else streams prose a word at a time.
 */
export class GatewayHarness {
  public tmp = "";
  public registry!: SessionRegistry;
  public gateway!: WsGateway;
  private modelServer: ReturnType<typeof Bun.serve> | undefined;
  private previousAgentDir: string | undefined;
  private agentDir = "";
  private port = 0;
  /** Held open by a test that wants the turn to still be in flight. */
  private gate: Promise<void> | undefined;

  public get url(): string {
    return this.gateway.url;
  }

  public get marker(): string {
    return join(this.tmp, "marker.txt");
  }

  public async start(): Promise<void> {
    this.tmp = await mkdtemp(join(tmpdir(), "pim-web-test-"));
    this.agentDir = join(this.tmp, "agent");
    await mkdir(join(this.agentDir, "extensions"), { recursive: true });
    this.previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = this.agentDir;
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
      customTools: () => [
        Tools.wrap(pingTool()) as unknown as ToolDefinition,
        Tools.wrap(shellTool(() => this.marker)) as unknown as ToolDefinition,
      ],
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
    if (this.previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = this.previousAgentDir;
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
        const tool = answered
          ? undefined
          : prompt.includes("shell")
            ? { name: "shell", args: { command: "echo hi" } }
            : prompt.includes("tool")
              ? { name: "ping", args: { text: "hi" } }
              : undefined;
        const gate = this.gate;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encode = (text: string) =>
              controller.enqueue(Buffer.from(text));
            encode(chunk({ role: "assistant", content: "" }));
            if (tool) {
              encode(
                chunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
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
                await Bun.sleep(15);
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

/** Polls until `test` holds; the store is a reactive object, not an emitter. */
export async function until(
  test: () => boolean,
  label: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await Bun.sleep(10);
  }
}
