import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const Schema = Type.Object({
  tps: Type.Object(
    {
      enabled: Type.Boolean({ default: false }),
    },
    { default: { enabled: false } }
  ),
});

type Settings = Static<typeof Schema>;

export class PimSettings {
  private static readonly path = join(getAgentDir(), "pim.json");
  private static cache: Settings | undefined;
  private static loadPromise: Promise<Settings> | undefined;
  private static writeQueue: Promise<unknown> = Promise.resolve();

  private static async load(): Promise<Settings> {
    if (PimSettings.cache !== undefined) {
      return PimSettings.cache;
    }
    PimSettings.loadPromise ??= (async () => {
      let raw: unknown;
      try {
        raw = await Bun.file(PimSettings.path).json();
      } catch {
        raw = {};
      }
      const filled = Value.Default(Schema, raw);
      const settings: Settings = Value.Check(Schema, filled)
        ? filled
        : Value.Create(Schema);
      PimSettings.cache = settings;
      return settings;
    })();
    return PimSettings.loadPromise;
  }

  static async get<K extends keyof Settings>(key: K): Promise<Settings[K]> {
    return (await PimSettings.load())[key];
  }

  static async set<K extends keyof Settings>(
    key: K,
    value: Settings[K]
  ): Promise<void> {
    const task = async (): Promise<void> => {
      const current = await PimSettings.load();
      const next: Settings = { ...current, [key]: value };
      if (!Value.Check(Schema, next)) {
        throw new Error(`Invalid value for pim setting "${String(key)}"`);
      }
      PimSettings.cache = next;
      await Bun.write(PimSettings.path, `${JSON.stringify(next, null, 2)}\n`);
    };
    PimSettings.writeQueue = PimSettings.writeQueue.then(task, task);
    await PimSettings.writeQueue;
  }
}
