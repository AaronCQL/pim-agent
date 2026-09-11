import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { SessionProjection } from "#server/SessionProjection";
import { FIXTURE_CWD, FIXTURE_EVENTS, FIXTURE_JSONL } from "./fixture";
import { pimTools } from "./tools";

/**
 * Regenerates `fixtures/session.jsonl` by driving a real pi session against a
 * scripted model, then re-projects it into `fixtures/events.json`.
 *
 *   bun packages/web/src/replay/generate.ts
 *
 * Committed rather than run in CI: it starts a real agent, runs real tools,
 * and is the only way to get a session file that actually contains a diff, a
 * failing command and markdown. `FIXTURE_CWD` is a fixed path so the absolute
 * paths pi records stay stable across regenerations.
 */

const WORKSPACE = FIXTURE_CWD;
const AGENT_DIR = join(WORKSPACE, ".agent");

const SOURCE = `export function greet(name: string): string {
  return "Hello, " + name + "!";
}

export function farewell(name: string): string {
  return "Bye, " + name;
}
`;

/** One scripted assistant turn: prose, then optionally one tool call. */
type Turn = {
  readonly text: string;
  readonly call?: { readonly name: string; readonly args: unknown };
};

const TURNS: readonly Turn[] = [
  {
    text: "Let me read the file first.",
    call: { name: "read", args: { path: "greeter.ts" } },
  },
  {
    text: "Now I'll switch it to a template literal.",
    call: {
      name: "edit",
      args: {
        path: "greeter.ts",
        edits: [
          {
            oldString: 'return "Hello, " + name + "!";',
            newString: "return `Hello, ${name}!`;",
          },
          {
            oldString: 'return "Bye, " + name;',
            newString: "return `Bye, ${name}`;",
          },
        ],
      },
    },
  },
  {
    text: "Running the type checker to confirm.",
    call: { name: "bash", args: { command: "tsc --noEmit greeter.ts" } },
  },
  {
    text: [
      "## Done",
      "",
      "Both concatenations in `greeter.ts` are now template literals:",
      "",
      "| function | change |",
      "| --- | --- |",
      '| `greet` | `"Hello, " + name` \u2192 `` `Hello, ${name}!` `` |',
      '| `farewell` | `"Bye, " + name` \u2192 `` `Bye, ${name}` `` |',
      "",
      "```ts",
      "export function greet(name: string): string {",
      "  return `Hello, ${name}!`;",
      "}",
      "```",
      "",
      "The type check **failed** because `tsc` is not installed here \u2014 see the",
      "tool output above. Nothing else was touched.",
    ].join("\n"),
  },
];

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "script",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

function startModelServer(): ReturnType<typeof Bun.serve> {
  let index = 0;
  return Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch() {
      const turn = TURNS[Math.min(index++, TURNS.length - 1)];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (text: string) =>
            controller.enqueue(Buffer.from(text, "utf8"));
          push(chunk({ role: "assistant", content: "" }));
          push(chunk({ content: turn?.text ?? "" }));
          if (turn?.call) {
            push(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${index}`,
                    type: "function",
                    function: {
                      name: turn.call.name,
                      arguments: JSON.stringify(turn.call.args),
                    },
                  },
                ],
              })
            );
            push(chunk({}, "tool_calls"));
          } else {
            push(chunk({}, "stop"));
          }
          push("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
}

async function main(): Promise<void> {
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(join(AGENT_DIR, "extensions"), { recursive: true });
  await Bun.write(join(WORKSPACE, "greeter.ts"), SOURCE);

  const model = startModelServer();
  await Bun.write(
    join(AGENT_DIR, "models.json"),
    JSON.stringify({
      providers: {
        script: {
          baseUrl: `http://localhost:${model.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture",
          models: [{ id: "echo", maxTokens: 4096, contextWindow: 16_384 }],
        },
      },
    })
  );
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

  const registry = new SessionRegistry({
    defaults: { cwd: WORKSPACE, model: "script/echo" },
    agentDir: AGENT_DIR,
    customTools: () => pimTools(),
  });
  await registry.init();
  const host = await registry.create({ cwd: WORKSPACE });
  await host.run((session) =>
    session.prompt("Modernise the string building in greeter.ts.")
  );

  const path = host.eventLog?.path;
  if (path === undefined) {
    throw new Error("session produced no log");
  }
  await Bun.write(FIXTURE_JSONL, Bun.file(path));

  const projection = new SessionProjection(FIXTURE_JSONL, () => WORKSPACE);
  await projection.drain();
  await Bun.write(
    FIXTURE_EVENTS,
    `${JSON.stringify(projection.since(0), null, 2)}\n`
  );

  await registry.disposeAll();
  await model.stop(true);
  console.log(`wrote ${FIXTURE_JSONL}\nwrote ${FIXTURE_EVENTS}`);
}

await main();
