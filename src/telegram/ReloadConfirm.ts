import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { Config } from "./Config.ts";

export type ReloadConfirmEntry = {
  readonly chatId: number;
  readonly threadId: number | undefined;
  readonly ts: string;
};

const FILE_NAME = "reload-confirm.json";

export class ReloadConfirm {
  public static path(configDir: string): string {
    return join(configDir, FILE_NAME);
  }

  public static async append(
    configDir: string,
    entry: ReloadConfirmEntry
  ): Promise<void> {
    const merged = [...(await ReloadConfirm.read(configDir)), entry];
    await Config.writeAtomic(
      ReloadConfirm.path(configDir),
      JSON.stringify(merged, null, 2)
    );
  }

  public static async read(
    configDir: string
  ): Promise<ReadonlyArray<ReloadConfirmEntry>> {
    const data = await Config.readJsonOrEmpty<unknown[]>(
      ReloadConfirm.path(configDir),
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

  public static async clear(configDir: string): Promise<void> {
    try {
      await unlink(ReloadConfirm.path(configDir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[reload-confirm] unlink failed:`, err);
      }
    }
  }
}
