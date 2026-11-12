import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagent from "../index";
import type { SubagentJobs } from "../SubagentJobs";
import {
  SubagentResult,
  type SubagentResultDetails,
} from "../SubagentResult";
import { HeldSession } from "./session";

export type ChatRequest = {
  readonly messages: readonly {
    readonly role: string;
    readonly content?: unknown;
  }[];
};

/** `spawn` starts one background job per prompt, each with its prompt as its id; `status` fails the request with that HTTP status. */
export type Reply =
  | { readonly text: string }
  | { readonly spawn: readonly string[] }
  | { readonly status: number };

export type Script = (
  request: ChatRequest,
  index: number
) => Reply | Promise<Reply>;

export type Parent = {
  readonly session: AgentSession;
  readonly requests: readonly ChatRequest[];
  /** What extensions reported failing. */
  readonly errors: readonly string[];
  /** The children spawned so far, by job id. */
  readonly children: ReadonlyMap<string, HeldSession>;
  /** The job's `subagent_result` entries, on every branch. */
  results(jobId: string): readonly SubagentResultDetails[];
  dispose(): Promise<void>;
};

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function stream(reply: Exclude<Reply, { readonly status: number }>): string {
  const body =
    "text" in reply
      ? [chunk({ content: reply.text }), chunk({}, "stop")]
      : [
          ...reply.spawn.map((prompt, index) =>
            chunk({
              tool_calls: [
                {
                  index,
                  id: prompt,
                  type: "function",
                  function: {
                    name: "subagent",
                    arguments: JSON.stringify({ action: "spawn", prompt }),
                  },
                },
              ],
            })
          ),
          chunk({}, "tool_calls"),
        ];
  return [
    chunk({ role: "assistant", content: "" }),
    ...body,
    "data: [DONE]\n\n",
  ].join("");
}

/** A real pi session running the core subagent extension, with `extensions` after it, against a scripted OpenAI-compatible model. Children are held until the test ends them. */
export async function startParent(options: {
  readonly jobs: SubagentJobs;
  readonly script: Script;
  readonly extensions?: readonly ExtensionFactory[];
  readonly settings?: Record<string, unknown>;
}): Promise<Parent> {
  const requests: ChatRequest[] = [];
  const errors: string[] = [];
  const children = new Map<string, HeldSession>();
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const request = (await req.json()) as ChatRequest;
      requests.push(request);
      const reply = await options.script(request, requests.length - 1);
      return "status" in reply
        ? new Response("scripted failure", { status: reply.status })
        : new Response(stream(reply), {
            headers: { "content-type": "text/event-stream" },
          });
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "pim-subagent-parent-"));
  const agentDir = join(dir, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        test: {
          baseUrl: `http://localhost:${server.port}/v1`,
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "echo", maxTokens: 1024, contextWindow: 65_536 }],
        },
      },
    })
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    ...options.settings,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir,
    settingsManager,
    extensionFactories: [
      subagent({
        jobs: options.jobs,
        createSession: async (_parent, { callId }) => {
          const child = new HeldSession();
          children.set(callId ?? "", child);
          return child;
        },
      }),
      ...(options.extensions ?? []),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    model: new ModelRegistry(modelRuntime).find("test", "echo"),
  });
  await session.bindExtensions({
    mode: "print",
    onError: (err) => {
      errors.push(`${err.extensionPath} (${err.event}): ${err.error}`);
    },
  });

  return {
    session,
    requests,
    errors,
    children,
    results: (jobId) =>
      session.sessionManager.getEntries().flatMap((entry) => {
        const details =
          entry.type === "custom_message"
            ? SubagentResult.detailsOf(entry)
            : undefined;
        return details?.jobId === jobId ? [details] : [];
      }),
    async dispose() {
      await options.jobs.stopEverything();
      session.dispose();
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
