import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { AttachmentStore } from "#core/attachments/AttachmentStore";
import type { AgentRuntime } from "#core/session/AgentRuntime";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { Tools } from "#core/shared/Tools";
import { defaultAttachmentsRoot } from "#server/AttachmentEndpoint";
import { SendFileTool } from "#server/SendFileTool";
import { WebOptions } from "#server/WebOptions";
import { WsGateway } from "#server/WsGateway";
import type { Surface } from "./Daemon";

function create(args: ReadonlyArray<string>, runtime: AgentRuntime): Surface {
  return {
    name: "web",
    start: async () => {
      const options = WebOptions.parse(args);
      const attachmentsRoot = defaultAttachmentsRoot();
      const store = new AttachmentStore(attachmentsRoot);
      const registry = new SessionRegistry({
        runtime,
        defaults: { cwd: options.cwd },
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
        hostname: options.hostname,
        port: WebOptions.port(options),
        attachmentsRoot,
        ...(options.clientDir === undefined
          ? {}
          : { clientDir: options.clientDir }),
      });
      gateway.start();
      process.stderr.write(
        `pim-server listening on ${gateway.url} (web UI: http://${options.hostname}:${gateway.port})\n`
      );

      return {
        stop: async () => {
          await gateway.stop();
          await registry.disposeAll();
        },
      };
    },
  };
}

export const WebSurface = { create };
