import { hostname } from "node:os";

import { FsErrors } from "./FsErrors";

/** A process anywhere: a pid only means something on its own host. */
export type ProcOwner = { readonly pid: number; readonly hostname: string };

export type ProcOptions = {
  readonly cwd?: string | undefined;
  readonly stdout?: "pipe" | "inherit";
  /** Merged over `process.env`; an `undefined` value removes the key. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Kills the child and sets `timedOut` once elapsed. */
  readonly timeoutMs?: number;
};

export type ProcResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

async function run(
  cmd: ReadonlyArray<string>,
  options: ProcOptions = {}
): Promise<ProcResult> {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd,
    stdout: options.stdout ?? "pipe",
    stderr: "pipe",
    env:
      options.env === undefined
        ? undefined
        : { ...process.env, ...options.env },
  });
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, options.timeoutMs);
  const [stdout, stderr] = await Promise.all([
    proc.stdout instanceof ReadableStream
      ? new Response(proc.stdout).text()
      : "",
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

/** EPERM means the process exists but belongs to another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return FsErrors.code(err) !== "ESRCH";
  }
}

const HOST = hostname();

/** This process. */
function self(): ProcOwner {
  return { pid: process.pid, hostname: HOST };
}

function isSelf(owner: ProcOwner | undefined): boolean {
  return owner?.pid === process.pid && owner.hostname === HOST;
}

/** On this host, where its pid can be checked. */
function isLocal(owner: ProcOwner): boolean {
  return owner.hostname === HOST;
}

export const Proc = { run, isAlive, self, isSelf, isLocal };
