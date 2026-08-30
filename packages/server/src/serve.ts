import { parseArgs } from "node:util";

import { SessionRegistry } from "../../core/src/session/SessionRegistry";
import { WsGateway } from "./WsGateway";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4319" },
    // Loopback until Phase 6 puts a bearer token in front of the tailnet.
    hostname: { type: "string", default: "127.0.0.1" },
    cwd: { type: "string", default: process.cwd() },
  },
  allowPositionals: false,
});

const registry = new SessionRegistry({ defaults: { cwd: values.cwd } });
await registry.init();

const gateway = new WsGateway({
  registry,
  hostname: values.hostname,
  port: Number(values.port),
});
gateway.start();
process.stderr.write(`pim-server listening on ${gateway.url}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await gateway.stop();
      await registry.disposeAll();
      process.exit(0);
    })();
  });
}
