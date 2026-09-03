import { SessionRegistry } from "../../core/src/session/SessionRegistry";
import { WsGateway } from "./WsGateway";

const DEFAULT_PORT = "4319";
/** Loopback only: the server has full host access and no authentication. */
const DEFAULT_HOSTNAME = "127.0.0.1";

type Cli = {
  readonly port: string;
  readonly hostname: string;
  readonly cwd: string;
  readonly clientDir: string | undefined;
};

/**
 * Tolerant on purpose: the same argv reaches here through `pim --mode serve`,
 * so unknown flags and the `serve` positional must not be fatal.
 */
function parseArgs(args: ReadonlyArray<string>): Cli {
  // PORT is honoured because a supervisor or container assigns it, but an
  // explicit `--port` always wins.
  let port = process.env["PORT"] ?? DEFAULT_PORT;
  let hostname = DEFAULT_HOSTNAME;
  let cwd = process.cwd();
  let clientDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const key = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    const inline = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;
    const take = (): string | undefined => {
      if (inline !== undefined) {
        return inline;
      }
      i += 1;
      return args[i];
    };

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
  }
  return { port, hostname, cwd, clientDir };
}

export async function start(args: ReadonlyArray<string>): Promise<void> {
  const values = parseArgs(args);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a port number, got "${values.port}"`);
  }

  const registry = new SessionRegistry({ defaults: { cwd: values.cwd } });
  await registry.init();

  const gateway = new WsGateway({
    registry,
    hostname: values.hostname,
    port,
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

if (import.meta.main) {
  await start(process.argv.slice(2));
}
