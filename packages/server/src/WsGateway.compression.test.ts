import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import type { ResponseEvent } from "#protocol/ServerEvent";
import { WsGateway } from "./WsGateway";

/**
 * What actually leaves the socket. Bun compresses a frame only when `send`
 * asks it to, so none of this can be read off the configuration: these tests
 * read the negotiated handshake and the frame bytes themselves.
 */

const RSV1 = 0x40;
const DIRECTORIES = 200;

let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let socket: ReturnType<typeof connect> | undefined;

type Wire = {
  readonly extensions: string;
  readonly compressed: boolean;
  readonly payload: Uint8Array;
};

function maskedFrame(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const mask = Uint8Array.from([1, 2, 3, 4]);
  const frame = new Uint8Array(6 + body.length);
  frame.set([0x81, 0x80 | body.length], 0);
  frame.set(mask, 2);
  for (let i = 0; i < body.length; i += 1) {
    frame[6 + i] = body[i]! ^ mask[i % 4]!;
  }
  return frame;
}

/** A server frame is never masked; `undefined` until every byte of one has landed. */
function unframe(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length < 2) {
    return undefined;
  }
  const flag = bytes[1]! & 0x7f;
  const offset = flag < 126 ? 2 : flag === 126 ? 4 : 10;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length =
    flag < 126
      ? flag
      : flag === 126
        ? view.getUint16(2)
        : Number(view.getBigUint64(2));
  return bytes.length >= offset + length
    ? bytes.subarray(offset, offset + length)
    : undefined;
}

/** Sends one command over a raw socket, offering `permessage-deflate` the way a browser does. */
async function exchange(command: object, deflate = true): Promise<Wire> {
  const url = new URL(gateway.url);
  return await new Promise<Wire>((resolve, reject) => {
    let head = "";
    let buffer = new Uint8Array(0);
    socket = connect(Number(url.port), url.hostname, () => {
      socket?.write(
        `GET / HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          (deflate
            ? "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n"
            : "") +
          "\r\n"
      );
    });
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      if (head === "") {
        head = chunk.subarray(0, chunk.indexOf("\r\n\r\n")).toString();
        socket?.write(maskedFrame(JSON.stringify(command)));
        return;
      }
      buffer = Uint8Array.from([...buffer, ...new Uint8Array(chunk)]);
      const payload = unframe(buffer);
      if (payload === undefined) {
        return;
      }
      resolve({
        extensions:
          head
            .split("\r\n")
            .find((line) => line.toLowerCase().startsWith("sec-websocket-ext"))
            ?.split(": ")[1] ?? "none",
        compressed: (buffer[0]! & RSV1) !== 0,
        payload,
      });
    });
  });
}

function decode(wire: Wire): ResponseEvent {
  const bytes = wire.compressed
    ? inflateRawSync(wire.payload, { finishFlush: constants.Z_SYNC_FLUSH })
    : wire.payload;
  return JSON.parse(new TextDecoder().decode(bytes)) as ResponseEvent;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-deflate-gateway-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  for (let i = 0; i < DIRECTORIES; i += 1) {
    await mkdir(join(tmp, `component-${String(i).padStart(4, "0")}`));
  }
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  registry = new SessionRegistry({ defaults: { cwd: tmp }, agentDir });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
    sessionMetaPath: join(tmp, "sessions.json"),
  });
  gateway.start();
});

afterEach(async () => {
  socket?.destroy();
  socket = undefined;
  await gateway.stop();
  await registry.disposeAll();
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("the deflate window survives between frames", async () => {
  const wire = await exchange({ id: "1", type: "list_models" });

  expect(wire.extensions).toContain("permessage-deflate");
  expect(wire.extensions).not.toContain("server_no_context_takeover");
});

test("an answer reaches a deflate-speaking client compressed and intact", async () => {
  const wire = await exchange({ id: "1", type: "list_dirs", path: tmp });

  expect(wire.compressed).toBe(true);
  const response = decode(wire);
  expect(response.success).toBe(true);
  expect(response.directory?.entries.length).toBeGreaterThanOrEqual(
    DIRECTORIES
  );
  expect(wire.payload.length).toBeLessThan(JSON.stringify(response).length / 4);
});

test("a client that never offered deflate is answered in plain frames", async () => {
  const wire = await exchange({ id: "1", type: "list_dirs", path: tmp }, false);

  expect(wire.extensions).toBe("none");
  expect(wire.compressed).toBe(false);
  expect(decode(wire).directory?.entries.length).toBeGreaterThanOrEqual(
    DIRECTORIES
  );
});
