import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Fs } from "../../core/src/shared/Fs";
import type { ScheduledTask } from "./TaskSchema";

async function loadAll(
  configDir: string
): Promise<ReadonlyArray<ScheduledTask>> {
  let entries: string[];
  try {
    entries = await readdir(dir(configDir));
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
          join(dir(configDir), name),
          undefined
        )
      )
  );
  return loaded.filter(
    (data): data is ScheduledTask =>
      !!data && typeof data === "object" && "id" in data
  );
}

async function save(configDir: string, task: ScheduledTask): Promise<void> {
  await Fs.writeAtomic(path(configDir, task.id), JSON.stringify(task, null, 2));
}

async function remove(configDir: string, id: string): Promise<void> {
  try {
    await unlink(path(configDir, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function makeId(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return slug ? `${slug}-${rand}` : rand;
}

function dir(configDir: string): string {
  return join(configDir, "tasks");
}

function path(configDir: string, id: string): string {
  return join(dir(configDir), `${id}.json`);
}

export const TaskStore = { loadAll, save, remove, makeId };
