import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

async function readJsonOrEmpty<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return (await Bun.file(filePath).json()) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
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

async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export const Fs = { readJsonOrEmpty, writeAtomic };
