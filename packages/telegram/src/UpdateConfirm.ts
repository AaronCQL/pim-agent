import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { Fs } from "#core/shared/Fs";

const CONFIRM_FILE = "update-confirm.json";

/** The "🔄 Updating..." message to edit once the restarted daemon is back. */
export type UpdateConfirmEntry = {
  readonly chatId: number;
  readonly threadId: number | undefined;
  readonly messageId: number;
};

async function append(
  configDir: string,
  entry: UpdateConfirmEntry
): Promise<void> {
  const merged = [...(await read(configDir)), entry];
  await Fs.writeAtomic(
    updateConfirmPath(configDir),
    JSON.stringify(merged, null, 2)
  );
}

async function read(
  configDir: string
): Promise<ReadonlyArray<UpdateConfirmEntry>> {
  const data = await Fs.readJsonOrEmpty<unknown[]>(
    updateConfirmPath(configDir),
    []
  );
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter(
    (e): e is UpdateConfirmEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as UpdateConfirmEntry).chatId === "number" &&
      ((e as UpdateConfirmEntry).threadId === undefined ||
        typeof (e as UpdateConfirmEntry).threadId === "number") &&
      typeof (e as UpdateConfirmEntry).messageId === "number"
  );
}

async function clear(configDir: string): Promise<void> {
  try {
    await unlink(updateConfirmPath(configDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[update-confirm] unlink failed:`, err);
    }
  }
}

function updateConfirmPath(configDir: string): string {
  return join(configDir, CONFIRM_FILE);
}

export const UpdateConfirm = { append, read, clear };
