import {
  type FSWatcher,
  readdirSync,
  statSync,
  watch as watchFs,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const POLL_MS = 1_000;

function signatureOf(path: string): string {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats === undefined
    ? "gone"
    : `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
}

/** Reports a change only once the path itself moved, so a watcher firing for its neighbours costs nothing. */
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

/**
 * `fs.watch` reports nothing at all on some filesystems and network mounts, so
 * the poll beside it is not optional. The poll also re-arms the watcher, which
 * a directory that does not exist yet refuses to give.
 */
function follow(
  watched: string,
  entry: string | undefined,
  onEvent: () => void,
  onPoll: () => void,
  pollMs: number
): () => void {
  let watcher: FSWatcher | undefined;
  const arm = (): void => {
    if (watcher !== undefined) {
      return;
    }
    try {
      watcher = watchFs(watched, { persistent: false }, (_event, changed) => {
        if (entry === undefined || changed === null || changed === entry) {
          onEvent();
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
    try {
      watcher?.close();
    } catch {}
  };
}

/** Fires when one file appears, grows, or goes away; the directory is watched, so the file need not exist yet. */
function file(
  path: string,
  onChange: () => void,
  pollMs: number = POLL_MS
): () => void {
  const check = tracker(path, onChange);
  return follow(dirname(path), basename(path), check, check, pollMs);
}

/** Fires when a directory gains or loses an entry, or when anything inside it is written. */
function directory(
  path: string,
  onChange: () => void,
  pollMs: number = POLL_MS
): () => void {
  // Writing a file moves nothing on the directory holding it, so the poll answers only for entries coming and going.
  return follow(path, undefined, onChange, tracker(path, onChange), pollMs);
}

/** The directories directly inside `path`, or none when it does not exist. */
function subdirectories(path: string): readonly string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

/** Watching paths other processes write: an `fs.watch` that may do nothing, backed by a poll that always does. */
export const FileWatch = { file, directory, subdirectories };
