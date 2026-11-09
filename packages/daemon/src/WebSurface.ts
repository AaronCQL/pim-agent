import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { AttachmentStore } from "#core/attachments/AttachmentStore";
import { AttachmentSweep } from "#core/attachments/AttachmentSweep";
import { SessionMeta } from "#core/session/SessionMeta";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { Tools } from "#core/shared/Tools";
import { defaultAttachmentsRoot } from "#server/AttachmentEndpoint";
import { SendFileTool } from "#server/SendFileTool";
import { WebOptions } from "#server/WebOptions";
import { WsGateway } from "#server/WsGateway";
import type { Surface, SurfaceDeps } from "./Daemon";

function create(args: ReadonlyArray<string>, deps: SurfaceDeps): Surface {
  return {
    name: "web",
    start: async () => {
      const options = WebOptions.parse(args);
      const attachmentsRoot = defaultAttachmentsRoot();
      const store = new AttachmentStore(attachmentsRoot);
      const registry = new SessionRegistry({
        runtime: deps.runtime,
        jobs: deps.jobs,
        defaults: { cwd: options.cwd },
        customTools: ({ cwd, sessionId }) => [
          Tools.wrap(
            SendFileTool.build({ store, cwd, sessionId })
          ) as ToolDefinition,
        ],
        surface: "web browser",
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
      const stopSweep = AttachmentSweep.install({
        root: attachmentsRoot,
        registry,
        meta: new SessionMeta(),
      });
      process.stderr.write(
        `pim-server listening on ${gateway.url} (web UI: http://${options.hostname}:${gateway.port})\n`
      );

      return {
        stop: async () => {
          stopSweep();
          await gateway.stop();
          await registry.disposeAll();
        },
      };
    },
  };
}

export const WebSurface = { create };
