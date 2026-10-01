import {
  type FSWatcher,
  readdirSync,
  statSync,
  watch as watchFs,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const POLL_MS = 1_000;

/** A burst arrives as one event, so look again shortly after to catch its last write. */
const SETTLE_MS = 25;

function signatureOf(path: string): string {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats === undefined
    ? "gone"
    : `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
}

/** Calls `onChange` only when the path's stat signature changed. */
function tracker(path: string, onChange: () => void): () => void {
  let signature = signatureOf(path);
  return (): void => {
    const next = signatureOf(path);
    if (next === signature) {
      return;
    }
    signature = next;
    onChange();
  };
}

/** `fs.watch` is silent on some filesystems, so a poll always runs too and re-arms a watcher that failed. */
function follow(
  watched: string,
  entry: string | undefined,
  onEvent: () => void,
  onPoll: () => void,
  pollMs: number
): () => void {
  let watcher: FSWatcher | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    onEvent();
    clearTimeout(settle);
    settle = setTimeout(onEvent, SETTLE_MS);
    settle.unref?.();
  };
  const arm = (): void => {
    if (watcher !== undefined) {
      return;
    }
    try {
      watcher = watchFs(watched, { persistent: false }, (_event, changed) => {
        if (entry === undefined || changed === null || changed === entry) {
          fire();
        }
      });
      watcher.on("error", () => {
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  };
  arm();
  const timer = setInterval(() => {
    arm();
    onPoll();
  }, pollMs);
  timer.unref?.();
  return (): void => {
    clearInterval(timer);
    clearTimeout(settle);
    try {
      watcher?.close();
    } catch {}
  };
}

/** Watches the parent directory, so the file need not exist yet. */
function file(
  path: string,
  onChange: () => void,
  pollMs: number = POLL_MS
): () => void {
  const check = tracker(path, onChange);
  return follow(dirname(path), basename(path), check, check, pollMs);
}

/** Fires on entries added, removed or written. The poll only sees adds and removes. */
function directory(
  path: string,
  onChange: () => void,
  pollMs: number = POLL_MS
): () => void {
  return follow(path, undefined, onChange, tracker(path, onChange), pollMs);
}

/** Empty when `path` is missing. */
function subdirectories(path: string): readonly string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

export const FileWatch = { file, directory, subdirectories };
