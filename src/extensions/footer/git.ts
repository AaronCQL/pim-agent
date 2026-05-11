import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";

export type GitState = {
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
};

export const EMPTY_GIT: GitState = {
  branch: null,
  dirty: false,
  ahead: 0,
  behind: 0,
};

export function parseGitStatus(text: string): GitState {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      branch = head === "(detached)" ? "detached" : head;
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.length > 0 && !line.startsWith("#")) {
      dirty = true;
    }
  }
  return { branch, dirty, ahead, behind };
}

export function watchGitDir(cwd: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 200);
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(join(cwd, ".git"), { persistent: false }, fire);
    watcher.on("error", () => {});
  } catch {
    // not a git repo, .git missing, or .git is a worktree gitfile — skip
  }
  return (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {}
    }
  };
}

export async function fetchGitStatus(cwd: string): Promise<GitState> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain=v2", "--branch"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
      return EMPTY_GIT;
    }
    return parseGitStatus(text);
  } catch {
    return EMPTY_GIT;
  }
}
