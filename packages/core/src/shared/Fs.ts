import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { FsErrors } from "./FsErrors";

async function readJsonOrEmpty<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return (await Bun.file(filePath).json()) as T;
  } catch (err) {
    if (FsErrors.code(err) === "ENOENT") {
      return fallback;
    }
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }
}

async function readJsonOr<T>(source: string | URL, fallback: T): Promise<T> {
  try {
    return (await Bun.file(source).json()) as T;
  } catch {
    return fallback;
  }
}

async function writeAtomic(
  filePath: string,
  data: string,
  mode?: number
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, data);
  const resolvedMode = mode ?? (await existingMode(filePath));
  if (resolvedMode !== undefined) {
    await chmod(tmp, resolvedMode);
  }
  await rename(tmp, filePath);
}

async function writeJson(
  filePath: string,
  value: unknown,
  mode = 0o600
): Promise<void> {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function writeKeepingLinks(
  filePath: string,
  content: string,
  options: { readonly mode?: number; readonly nlink: number }
): Promise<void> {
  if (options.nlink > 1) {
    await Bun.write(filePath, content);
    return;
  }
  await writeAtomic(filePath, content, options.mode);
}

function serialised(): {
  run: <T>(task: () => Promise<T>) => Promise<T>;
} {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    run: <T>(task: () => Promise<T>): Promise<T> => {
      const next = queue.then(task, task);
      queue = next;
      return next;
    },
  };
}

async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (err) {
    if (FsErrors.code(err) === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export const Fs = {
  readJsonOrEmpty,
  readJsonOr,
  writeAtomic,
  writeJson,
  writeKeepingLinks,
  serialised,
};
