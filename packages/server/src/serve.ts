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
  // An explicit `--port` always wins over `PORT`.
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
