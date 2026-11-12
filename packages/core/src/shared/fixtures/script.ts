import { until } from "./wait";

export type Script = {
  readonly pid: number;
  readonly stdout: () => string;
  readonly exited: Promise<number>;
  readonly printed: (line: string) => Promise<void>;
};

/** Runs a Bun script in its own process, so it can take real signals. */
export function runScript(path: string, args: readonly string[]): Script {
  const proc = Bun.spawn(["bun", path, ...args], {
    stdout: "pipe",
    stderr: "inherit",
  });
  let text = "";
  const read = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      text += decoder.decode(chunk, { stream: true });
    }
  })();
  const lines = (): readonly string[] => text.split("\n");
  return {
    pid: proc.pid,
    stdout: () => text,
    exited: Promise.all([proc.exited, read]).then(([code]) => code),
    printed: (line) =>
      until(() => lines().includes(line), `${path} to print "${line}"`),
  };
}
