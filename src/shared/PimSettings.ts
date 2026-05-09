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

  private static async readFromDisk(): Promise<unknown> {
    const file = Bun.file(PimSettings.path);
    if (!(await file.exists())) {
      return {};
    }
    try {
      return await file.json();
    } catch {
      return {};
    }
  }

  static async load(): Promise<Settings> {
    const raw = await PimSettings.readFromDisk();
    const filled = Value.Default(Schema, structuredClone(raw ?? {}));
    if (Value.Check(Schema, filled)) {
      return filled;
    }
    return Value.Create(Schema);
  }

  static async get<K extends keyof Settings>(key: K): Promise<Settings[K]> {
    return (await PimSettings.load())[key];
  }

  static async set<K extends keyof Settings>(
    key: K,
    value: Settings[K]
  ): Promise<void> {
    const current = await PimSettings.load();
    const next: Settings = { ...current, [key]: value };
    if (!Value.Check(Schema, next)) {
      throw new Error(`Invalid value for pim setting "${String(key)}"`);
    }
    await Bun.write(PimSettings.path, `${JSON.stringify(next, null, 2)}\n`);
  }
}
