import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { Fs } from "./Fs";
import { Paths } from "./Paths";

const Schema = Type.Object({
  extensions: Type.Object(
    {
      toggles: Type.Record(Type.String(), Type.Boolean(), { default: {} }),
    },
    { default: { toggles: {} } }
  ),
  exa: Type.Object(
    {
      apiKey: Type.Optional(Type.String()),
    },
    { default: {} }
  ),
  jina: Type.Object(
    {
      apiKey: Type.Optional(Type.String()),
    },
    { default: {} }
  ),
  firecrawl: Type.Object(
    {
      apiKey: Type.Optional(Type.String()),
    },
    { default: {} }
  ),
});

type Settings = Static<typeof Schema>;

let cache: Settings | undefined;
let cachePath: string | undefined;
let loadPromise: Promise<Settings> | undefined;
let loadPromisePath: string | undefined;
let writeQueue: Promise<unknown> = Promise.resolve();

function path(): string {
  return join(Paths.pimHomeDir(), "settings.json");
}

async function load(): Promise<Settings> {
  const settingsPath = path();
  if (cache !== undefined && cachePath === settingsPath) {
    return cache;
  }
  if (loadPromisePath !== settingsPath) {
    loadPromise = undefined;
    loadPromisePath = settingsPath;
  }
  loadPromise ??= (async () => {
    let raw: unknown;
    try {
      raw = await Bun.file(settingsPath).json();
    } catch {
      raw = {};
    }
    const filled = Value.Default(Schema, raw);
    const settings: Settings = Value.Check(Schema, filled)
      ? filled
      : Value.Create(Schema);
    cache = settings;
    cachePath = settingsPath;
    return settings;
  })();
  return loadPromise;
}

async function ensureHomeDir(): Promise<void> {
  const dir = Paths.pimHomeDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function getExaApiKey(): Promise<string | undefined> {
  return (
    normalize(process.env["EXA_API_KEY"]) ??
    normalize((await get("exa")).apiKey)
  );
}

async function getJinaApiKey(): Promise<string | undefined> {
  return (
    normalize(process.env["JINA_API_KEY"]) ??
    normalize((await get("jina")).apiKey)
  );
}

async function getFirecrawlApiKey(): Promise<string | undefined> {
  return (
    normalize(process.env["FIRECRAWL_API_KEY"]) ??
    normalize((await get("firecrawl")).apiKey)
  );
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

async function get<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  return (await load())[key];
}

async function set<K extends keyof Settings>(
  key: K,
  value: Settings[K]
): Promise<void> {
  const task = async (): Promise<void> => {
    const current = await load();
    const next: Settings = { ...current, [key]: value };
    if (!Value.Check(Schema, next)) {
      throw new Error(`Invalid value for pim setting "${String(key)}"`);
    }
    const settingsPath = path();
    cache = next;
    cachePath = settingsPath;
    await ensureHomeDir();
    await Fs.writeAtomic(
      settingsPath,
      `${JSON.stringify(next, null, 2)}\n`,
      0o600
    );
  };
  writeQueue = writeQueue.then(task, task);
  await writeQueue;
}

export const PimSettings = {
  path,
  getExaApiKey,
  getJinaApiKey,
  getFirecrawlApiKey,
  get,
  set,
};
