import { resolve } from "node:path";

import { Cli as Argv } from "#core/shared/Cli";
import { DEFAULT_HOSTNAME, DEFAULT_PORT } from "./WsGateway";

export type WebOptions = {
  readonly port: string;
  readonly hostname: string;
  readonly cwd: string;
  readonly clientDir: string | undefined;
};

/**
 * `--web-cwd` wins over `--cwd`, which the Telegram surface reads out of the
 * same argv as its own default directory. Only the frozen unit uses it.
 */
function parse(args: ReadonlyArray<string>): WebOptions {
  // An explicit `--port` always wins over `PORT`.
  let port = process.env["PORT"] ?? String(DEFAULT_PORT);
  let hostname = DEFAULT_HOSTNAME;
  let cwd = process.cwd();
  let webCwd: string | undefined;
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
      case "--web-cwd":
        webCwd = take() ?? webCwd;
        break;
      case "--client-dir":
        clientDir = take() ?? clientDir;
        break;
      default:
        break;
    }
  });
  return { port, hostname, cwd: webCwd ?? cwd, clientDir };
}

/** The argv a supervisor has to start the daemon with to serve these same options. */
function freeze(options: WebOptions): ReadonlyArray<string> {
  return [
    "--port",
    options.port,
    "--hostname",
    options.hostname,
    "--web-cwd",
    resolve(options.cwd),
    ...(options.clientDir === undefined
      ? []
      : ["--client-dir", resolve(options.clientDir)]),
  ];
}

function port(options: WebOptions): number {
  const value = Number(options.port);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`--port must be a port number, got "${options.port}"`);
  }
  return value;
}

export const WebOptions = { parse, freeze, port };
