export type ModelServer = {
  readonly port: number | undefined;
  /** Holds every turn after its first word until the returned release is called. */
  readonly holdTurn: () => () => void;
  readonly stop: () => Promise<void>;
};

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

/** An OpenAI-compatible model that answers one word. */
export function startModelServer(): ModelServer {
  let gate: Promise<void> | undefined;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encode = (text: string) =>
            controller.enqueue(Buffer.from(text));
          encode(chunk({ role: "assistant", content: "working" }));
          await gate;
          encode(chunk({}, "stop"));
          encode("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port,
    holdTurn() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
    stop: () => server.stop(true),
  };
}
