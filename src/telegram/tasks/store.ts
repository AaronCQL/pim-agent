import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { readJsonOrEmpty, writeAtomic } from "../config";
import type { ScheduledTask } from "./schema";

export function tasksDir(configDir: string): string {
  return join(configDir, "tasks");
}

function taskPath(configDir: string, id: string): string {
  return join(tasksDir(configDir), `${id}.json`);
}

export async function loadAllTasks(
  configDir: string
): Promise<ReadonlyArray<ScheduledTask>> {
  let entries: string[];
  try {
    entries = await readdir(tasksDir(configDir));
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
        readJsonOrEmpty<ScheduledTask | undefined>(
          join(tasksDir(configDir), name),
          undefined
        )
      )
  );
  return loaded.filter(
    (data): data is ScheduledTask =>
      !!data && typeof data === "object" && "id" in data
  );
}

export async function saveTask(
  configDir: string,
  task: ScheduledTask
): Promise<void> {
  await writeAtomic(
    taskPath(configDir, task.id),
    JSON.stringify(task, null, 2)
  );
}

export async function deleteTaskFile(
  configDir: string,
  id: string
): Promise<void> {
  try {
    await unlink(taskPath(configDir, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export function makeTaskId(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return slug ? `${slug}-${rand}` : rand;
}
