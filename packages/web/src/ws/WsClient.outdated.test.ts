import { afterEach, beforeEach, expect, test } from "bun:test";

import { CLOSE_PROTOCOL_MISMATCH } from "#protocol/Protocol";
import { WsClient, type ConnectionStatus } from "./WsClient";

/**
 * A server that refuses everything the way a newer one refuses an older
 * client: the response first, then the close code that says not to come back.
 */
function startRefusingServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (req, self) =>
      self.upgrade(req, { data: undefined })
        ? undefined
        : new Response("no", { status: 400 }),
    websocket: {
      message: (ws, raw) => {
        const { id } = JSON.parse(String(raw)) as { readonly id: string };
        ws.send(
          JSON.stringify({
            type: "response",
            id,
            success: false,
            error: "unsupported protocol version",
          })
        );
        ws.close(CLOSE_PROTOCOL_MISMATCH, "protocol version mismatch");
      },
      open: () => {
        connections += 1;
      },
    },
  });
}

let server: ReturnType<typeof Bun.serve> | undefined;
let connections = 0;

/** The refusal arrives as a response first, so the close trails the attach. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

beforeEach(() => {
  connections = 0;
  server = startRefusingServer();
});

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

test("a refused protocol version settles the client instead of spinning", async () => {
  const statuses: ConnectionStatus[] = [];
  let backoffs = 0;
  const client = new WsClient({
    url: `ws://127.0.0.1:${server!.port}`,
    onEvent: () => {},
    onStatus: (status) => statuses.push(status),
    backoffMs: () => {
      backoffs += 1;
      return 0;
    },
  });

  await client.connect().catch(() => {});
  await until(() => client.status !== "open", "the server to hang up");

  expect(client.status).toBe("outdated");
  // A retry would have asked for its delay by now, and would have announced
  // itself as `reconnecting` on the way: neither happened, so there is no
  // timer waiting to throw this client at a server that has already said no.
  expect(backoffs).toBe(0);
  expect(statuses).toEqual(["connecting", "open", "outdated"]);
  expect(connections).toBe(1);
  client.close();
});
