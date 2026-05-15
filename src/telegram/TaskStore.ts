import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Fs } from "../shared/Fs";
import type { ScheduledTask } from "./TaskSchema";

export class TaskStore {
  public static async loadAll(
    configDir: string
  ): Promise<ReadonlyArray<ScheduledTask>> {
    let entries: string[];
    try {
      entries = await readdir(TaskStore.dir(configDir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const loaded = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          Fs.readJsonOrEmpty<ScheduledTask | undefined>(
            join(TaskStore.dir(configDir), name),
            undefined
          )
        )
    );
    return loaded.filter(
      (data): data is ScheduledTask =>
        !!data && typeof data === "object" && "id" in data
    );
  }

  public static async save(
    configDir: string,
    task: ScheduledTask
  ): Promise<void> {
    await Fs.writeAtomic(
      TaskStore.path(configDir, task.id),
      JSON.stringify(task, null, 2)
    );
  }

  public static async delete(configDir: string, id: string): Promise<void> {
    try {
      await unlink(TaskStore.path(configDir, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  public static makeId(prompt: string): string {
    const slug = prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const rand = Math.random().toString(36).slice(2, 8);
    return slug ? `${slug}-${rand}` : rand;
  }

  private static dir(configDir: string): string {
    return join(configDir, "tasks");
  }

  private static path(configDir: string, id: string): string {
    return join(TaskStore.dir(configDir), `${id}.json`);
  }
}
