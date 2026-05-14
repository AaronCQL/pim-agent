import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { readJsonOrEmpty, writeAtomic } from "./config.ts";

export type ReloadConfirmEntry = {
  readonly chatId: number;
  readonly threadId: number | undefined;
  readonly ts: string;
};

const FILE_NAME = "reload-confirm.json";

export function reloadConfirmPath(configDir: string): string {
  return join(configDir, FILE_NAME);
}

export async function appendReloadConfirm(
  configDir: string,
  entry: ReloadConfirmEntry
): Promise<void> {
  const merged = [...(await readReloadConfirm(configDir)), entry];
  await writeAtomic(
    reloadConfirmPath(configDir),
    JSON.stringify(merged, null, 2)
  );
}

export async function readReloadConfirm(
  configDir: string
): Promise<ReadonlyArray<ReloadConfirmEntry>> {
  const data = await readJsonOrEmpty<unknown[]>(
    reloadConfirmPath(configDir),
    []
  );
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter(
    (e): e is ReloadConfirmEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as ReloadConfirmEntry).chatId === "number" &&
      ((e as ReloadConfirmEntry).threadId === undefined ||
        typeof (e as ReloadConfirmEntry).threadId === "number") &&
      typeof (e as ReloadConfirmEntry).ts === "string"
  );
}

export async function clearReloadConfirm(configDir: string): Promise<void> {
  try {
    await unlink(reloadConfirmPath(configDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[reload-confirm] unlink failed:`, err);
    }
  }
}
