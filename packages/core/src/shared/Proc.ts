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

export const Proc = { run };
