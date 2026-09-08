export type ProcOptions = {
  readonly cwd?: string | undefined;
  readonly stdout?: "pipe" | "inherit";
};

export type ProcResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function run(
  cmd: ReadonlyArray<string>,
  options: ProcOptions = {}
): Promise<ProcResult> {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd,
    stdout: options.stdout ?? "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    proc.stdout instanceof ReadableStream
      ? new Response(proc.stdout).text()
      : "",
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

export const Proc = { run };
