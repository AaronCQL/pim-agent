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
  read: Type.Object(
    {
      dedupImages: Type.Boolean({ default: true }),
    },
    { default: { dedupImages: true } }
  ),
});

type Settings = Static<typeof Schema>;

let loaded: Promise<Settings> | undefined;
let loadedPath: string | undefined;
const writes = Fs.serialised();

function path(): string {
  return join(Paths.pimHomeDir(), "settings.json");
}

function load(): Promise<Settings> {
  const settingsPath = path();
  if (loadedPath !== settingsPath) {
    loaded = undefined;
    loadedPath = settingsPath;
  }
  loaded ??= (async () => {
    const raw = await Fs.readJsonOr<unknown>(settingsPath, {});
    const filled = Value.Default(Schema, raw);
    return Value.Check(Schema, filled) ? filled : Value.Create(Schema);
  })();
  return loaded;
}

function getExaApiKey(): Promise<string | undefined> {
  return apiKey("EXA_API_KEY", "exa");
}

function getJinaApiKey(): Promise<string | undefined> {
  return apiKey("JINA_API_KEY", "jina");
}

function getFirecrawlApiKey(): Promise<string | undefined> {
  return apiKey("FIRECRAWL_API_KEY", "firecrawl");
}

/** The env var wins over the settings file. */
async function apiKey(
  envName: string,
  key: "exa" | "jina" | "firecrawl"
): Promise<string | undefined> {
  return normalize(process.env[envName]) ?? normalize((await get(key)).apiKey);
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

async function get<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  return (await load())[key];
}

function set<K extends keyof Settings>(
  key: K,
  value: Settings[K]
): Promise<void> {
  return update(key, () => value);
}

function update<K extends keyof Settings>(
  key: K,
  mutate: (current: Settings[K]) => Settings[K]
): Promise<void> {
  return writes.run(async () => {
    const current = await load();
    const next: Settings = { ...current, [key]: mutate(current[key]) };
    if (!Value.Check(Schema, next)) {
      throw new Error(`Invalid value for pim setting "${String(key)}"`);
    }
    const settingsPath = path();
    loaded = Promise.resolve(next);
    loadedPath = settingsPath;
    await Paths.ensurePimHome();
    await Fs.writeJson(settingsPath, next);
  });
}

export const PimSettings = {
  path,
  getExaApiKey,
  getJinaApiKey,
  getFirecrawlApiKey,
  get,
  set,
  update,
};
