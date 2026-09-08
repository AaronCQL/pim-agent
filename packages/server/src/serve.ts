import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { AttachmentStore } from "#core/attachments/AttachmentStore";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { Cli as Argv } from "#core/shared/Cli";
import { Tools } from "#core/shared/Tools";
import { defaultAttachmentsRoot } from "./AttachmentEndpoint";
import { SendFileTool } from "./SendFileTool";
import { DEFAULT_HOSTNAME, DEFAULT_PORT, WsGateway } from "./WsGateway";

export type Cli = {
  readonly port: string;
  readonly hostname: string;
  readonly cwd: string;
  readonly clientDir: string | undefined;
};

export function parseArgs(args: ReadonlyArray<string>): Cli {
  // PORT is honoured because a supervisor or container assigns it, but an
  // explicit `--port` always wins.
  let port = process.env["PORT"] ?? String(DEFAULT_PORT);
  let hostname = DEFAULT_HOSTNAME;
  let cwd = process.cwd();
  let clientDir: string | undefined;

  Argv.scan(args, (key, take) => {
    switch (key) {
      case "--port":
        port = take() ?? port;
        break;
      case "--hostname":
        hostname = take() ?? hostname;
        break;
      case "--cwd":
        cwd = take() ?? cwd;
        break;
      case "--client-dir":
        clientDir = take() ?? clientDir;
        break;
      default:
        break;
    }
  });
  return { port, hostname, cwd, clientDir };
}

export async function start(args: ReadonlyArray<string>): Promise<void> {
  const values = parseArgs(args);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a port number, got "${values.port}"`);
  }

  // One root, both directions: what a browser uploads and what the agent
  // sends back are the same kind of stored file, answered by the same route.
  const attachmentsRoot = defaultAttachmentsRoot();
  const store = new AttachmentStore(attachmentsRoot);

  const registry = new SessionRegistry({
    defaults: { cwd: values.cwd },
    customTools: ({ cwd, sessionId }) => [
      Tools.wrap(
        SendFileTool.build({ store, cwd, sessionId })
      ) as ToolDefinition,
    ],
    systemInstruction: async () =>
      "The user is interacting with you via a web browser.",
  });
  await registry.init();

  const gateway = new WsGateway({
    registry,
    hostname: values.hostname,
    port,
    attachmentsRoot,
    ...(values.clientDir === undefined ? {} : { clientDir: values.clientDir }),
  });
  gateway.start();
  process.stderr.write(
    `pim-server listening on ${gateway.url} (web UI: http://${values.hostname}:${gateway.port})\n`
  );

  // Resolves only on shutdown, so callers can `await start()` and then exit.
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void (async () => {
          await gateway.stop();
          await registry.disposeAll();
          resolve();
        })();
      });
    }
  });
}
