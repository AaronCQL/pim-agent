import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Fs } from "#core/shared/Fs";
import { Config, type TelegramConfig } from "./Config";

const ENV_KEYS = [
  "PIM_TELEGRAM_BOT_TOKEN",
  "PIM_TELEGRAM_ALLOW",
  "PIM_HOME_DIR",
] as const;

let savedEnv: Record<string, string | undefined>;
let tmp: string;

beforeEach(async () => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmp = await mkdtemp(join(tmpdir(), "pim-telegram-test-"));
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
  await rm(tmp, { recursive: true, force: true });
});

describe("Config.parseArgs", () => {
  test("parses space-separated flags", () => {
    const cli = Config.parseArgs([
      "--mode",
      "telegram",
      "--token",
      "abc:xyz",
      "--allow",
      "111,222",
      "--cwd",
      "/work",
      "--model",
      "sonnet",
      "--config-dir",
      "/c",
    ]);
    expect(cli).toEqual({
      token: "abc:xyz",
      allow: "111,222",
      cwd: "/work",
      model: "sonnet",
      configDir: "/c",
    });
  });

  test("parses --key=value form", () => {
    const cli = Config.parseArgs([
      "--mode=telegram",
      "--token=abc",
      "--allow=1",
    ]);
    expect(cli.token).toBe("abc");
    expect(cli.allow).toBe("1");
  });

  test("ignores unknown positional args and unknown flags", () => {
    const cli = Config.parseArgs([
      "positional",
      "--unknown",
      "x",
      "--token",
      "t",
    ]);
    expect(cli.token).toBe("t");
  });

  test("consumes --mode value so it does not leak into the next flag", () => {
    const cli = Config.parseArgs(["--mode", "telegram", "--token", "t"]);
    expect(cli.token).toBe("t");
  });
});

describe("Config.load precedence", () => {
  test("CLI wins over env and file", async () => {
    process.env.PIM_TELEGRAM_BOT_TOKEN = "env-tok";
    process.env.PIM_TELEGRAM_ALLOW = "9";
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "file-tok", allow: [1] })
    );
    const cfg = await Config.load({
      token: "cli-tok",
      allow: "2,3",
      configDir: tmp,
    });
    expect(cfg.token).toBe("cli-tok");
    expect(cfg.allow).toEqual([2, 3]);
  });

  test("env wins over file when no CLI value", async () => {
    process.env.PIM_TELEGRAM_BOT_TOKEN = "env-tok";
    process.env.PIM_TELEGRAM_ALLOW = "9";
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "file-tok", allow: [1] })
    );
    const cfg = await Config.load({
      configDir: tmp,
    });
    expect(cfg.token).toBe("env-tok");
    expect(cfg.allow).toEqual([9]);
  });

  test("file values used when neither CLI nor env set", async () => {
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "file-tok", allow: [1, 2], cwd: "/from-file" })
    );
    const cfg = await Config.load({
      configDir: tmp,
    });
    expect(cfg.token).toBe("file-tok");
    expect(cfg.allow).toEqual([1, 2]);
    expect(cfg.cwd).toBe("/from-file");
  });

  test("PIM_HOME_DIR resolves the config directory", async () => {
    process.env.PIM_HOME_DIR = tmp;
    process.env.PIM_TELEGRAM_BOT_TOKEN = "t";
    const cfg = await Config.load({});
    expect(cfg.configDir).toBe(join(tmp, "telegram"));
  });

  test("throws when no token from any source", async () => {
    await expect(Config.load({ configDir: tmp })).rejects.toThrow(
      /token required/i
    );
  });

  test("missing config.json is not an error", async () => {
    const cfg = await Config.load({
      token: "t",
      configDir: tmp,
    });
    expect(cfg.allow).toEqual([]);
  });

  test("rejects non-numeric allow entries", async () => {
    await expect(
      Config.load({
        token: "t",
        allow: "1,abc",
        configDir: tmp,
      })
    ).rejects.toThrow(/Invalid chat ID/);
  });

  test("trims whitespace and drops empty entries in allow", async () => {
    const cfg = await Config.load({
      token: "t",
      allow: " 1 , ,2 ",
      configDir: tmp,
    });
    expect(cfg.allow).toEqual([1, 2]);
  });

  test.each<[string, unknown, number[]]>([
    ["a single number", 12345, [12345]],
    ["a comma-separated string", "1, 2 ,3", [1, 2, 3]],
    ["a mixed-type array", [1, "2", 3], [1, 2, 3]],
  ])("accepts allow as %s in config.json", async (_, allow, expected) => {
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "t", allow })
    );
    const cfg = await Config.load({ configDir: tmp });
    expect(cfg.allow).toEqual(expected);
  });

  test("malformed config.json surfaces a clear error", async () => {
    await Bun.write(join(tmp, "config.json"), "{not json");
    await expect(Config.load({ token: "t", configDir: tmp })).rejects.toThrow(
      /Failed to parse/
    );
  });
});

describe("Config.save + Fs.writeAtomic", () => {
  test("save writes a file readable by load", async () => {
    const cfg: TelegramConfig = {
      token: "tok",
      allow: [1, 2],
      cwd: "/work",
      model: "sonnet",
      configDir: tmp,
    };
    await Config.save(cfg);
    const reloaded = await Config.load({
      configDir: tmp,
    });
    expect(reloaded.token).toBe("tok");
    expect(reloaded.allow).toEqual([1, 2]);
    expect(reloaded.cwd).toBe("/work");
    expect(reloaded.model).toBe("sonnet");
  });

  test("writeAtomic applies explicit mode", async () => {
    const path = join(tmp, "secret.json");
    await Fs.writeAtomic(path, "{}", 0o600);
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
  });

  test("writeAtomic preserves an existing file's mode when no mode is passed", async () => {
    const path = join(tmp, "existing.json");
    await Bun.write(path, "{}");
    await chmod(path, 0o640);
    await Fs.writeAtomic(path, "{}");
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o640);
  });

  test("Config.save writes config.json as 0600", async () => {
    await Config.save({
      token: "tok",
      allow: [],
      cwd: "/work",
      configDir: tmp,
    });
    const s = await stat(join(tmp, "config.json"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  test("writeAtomic leaves no temp files behind", async () => {
    await Fs.writeAtomic(join(tmp, "x.json"), "{}");
    const glob = new Bun.Glob("x.json.tmp-*");
    const leftovers = await Array.fromAsync(glob.scan({ cwd: tmp }));
    expect(leftovers).toEqual([]);
  });
});
