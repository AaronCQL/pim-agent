import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  loadConfig,
  loadState,
  parseArgs,
  saveConfigAtomic,
  saveStateAtomic,
  type TelegramConfig,
} from "./config";

const ENV_KEYS = [
  "PIM_TELEGRAM_BOT_TOKEN",
  "PIM_TELEGRAM_ALLOW",
  "PIM_TELEGRAM_DIR",
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

describe("parseArgs", () => {
  test("parses space-separated flags", () => {
    const cli = parseArgs([
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
      printConfig: false,
    });
  });

  test("parses --key=value form", () => {
    const cli = parseArgs(["--mode=telegram", "--token=abc", "--allow=1"]);
    expect(cli.token).toBe("abc");
    expect(cli.allow).toBe("1");
  });

  test("--print-config is a boolean flag", () => {
    const cli = parseArgs(["--print-config", "--token", "t"]);
    expect(cli.printConfig).toBe(true);
    expect(cli.token).toBe("t");
  });

  test("ignores unknown positional args and unknown flags", () => {
    const cli = parseArgs(["positional", "--unknown", "x", "--token", "t"]);
    expect(cli.token).toBe("t");
  });

  test("consumes --mode value so it does not leak into the next flag", () => {
    const cli = parseArgs(["--mode", "telegram", "--token", "t"]);
    expect(cli.token).toBe("t");
  });
});

describe("loadConfig precedence", () => {
  test("CLI wins over env and file", async () => {
    process.env.PIM_TELEGRAM_BOT_TOKEN = "env-tok";
    process.env.PIM_TELEGRAM_ALLOW = "9";
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "file-tok", allow: [1] })
    );
    const cfg = await loadConfig({
      token: "cli-tok",
      allow: "2,3",
      configDir: tmp,
      printConfig: false,
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
    const cfg = await loadConfig({
      configDir: tmp,
      printConfig: false,
    });
    expect(cfg.token).toBe("env-tok");
    expect(cfg.allow).toEqual([9]);
  });

  test("file values used when neither CLI nor env set", async () => {
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "file-tok", allow: [1, 2], cwd: "/from-file" })
    );
    const cfg = await loadConfig({
      configDir: tmp,
      printConfig: false,
    });
    expect(cfg.token).toBe("file-tok");
    expect(cfg.allow).toEqual([1, 2]);
    expect(cfg.cwd).toBe("/from-file");
  });

  test("PIM_TELEGRAM_DIR resolves the config directory", async () => {
    process.env.PIM_TELEGRAM_DIR = tmp;
    process.env.PIM_TELEGRAM_BOT_TOKEN = "t";
    const cfg = await loadConfig({ printConfig: false });
    expect(cfg.configDir).toBe(tmp);
  });

  test("throws when no token from any source", async () => {
    await expect(
      loadConfig({ configDir: tmp, printConfig: false })
    ).rejects.toThrow(/token required/i);
  });

  test("missing config.json is not an error", async () => {
    const cfg = await loadConfig({
      token: "t",
      configDir: tmp,
      printConfig: false,
    });
    expect(cfg.allow).toEqual([]);
  });

  test("rejects non-numeric allow entries", async () => {
    await expect(
      loadConfig({
        token: "t",
        allow: "1,abc",
        configDir: tmp,
        printConfig: false,
      })
    ).rejects.toThrow(/Invalid chat ID/);
  });

  test("trims whitespace and drops empty entries in allow", async () => {
    const cfg = await loadConfig({
      token: "t",
      allow: " 1 , ,2 ",
      configDir: tmp,
      printConfig: false,
    });
    expect(cfg.allow).toEqual([1, 2]);
  });

  test("accepts allow as a single number in config.json", async () => {
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "t", allow: 12345 })
    );
    const cfg = await loadConfig({ configDir: tmp, printConfig: false });
    expect(cfg.allow).toEqual([12345]);
  });

  test("accepts allow as a comma-separated string in config.json", async () => {
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "t", allow: "1, 2 ,3" })
    );
    const cfg = await loadConfig({ configDir: tmp, printConfig: false });
    expect(cfg.allow).toEqual([1, 2, 3]);
  });

  test("accepts allow as a mixed-type array in config.json", async () => {
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({ token: "t", allow: [1, "2", 3] })
    );
    const cfg = await loadConfig({ configDir: tmp, printConfig: false });
    expect(cfg.allow).toEqual([1, 2, 3]);
  });

  test("malformed config.json surfaces a clear error", async () => {
    await Bun.write(join(tmp, "config.json"), "{not json");
    await expect(
      loadConfig({ token: "t", configDir: tmp, printConfig: false })
    ).rejects.toThrow(/Failed to parse/);
  });
});

describe("Config state + atomic writes", () => {
  test("loadState returns empty when state.json missing", async () => {
    const state = await loadState(tmp);
    expect(state).toEqual({ threads: {} });
  });

  test("state round-trips through saveStateAtomic", async () => {
    await saveStateAtomic(tmp, {
      threads: { "111-main": { cwd: "/x", model: "sonnet" } },
    });
    const state = await loadState(tmp);
    expect(state.threads["111-main"]).toEqual({ cwd: "/x", model: "sonnet" });
  });

  test("saveConfigAtomic writes a file readable by loadConfig", async () => {
    const cfg: TelegramConfig = {
      token: "tok",
      allow: [1, 2],
      cwd: "/work",
      model: "sonnet",
      configDir: tmp,
    };
    await saveConfigAtomic(cfg);
    const reloaded = await loadConfig({
      configDir: tmp,
      printConfig: false,
    });
    expect(reloaded.token).toBe("tok");
    expect(reloaded.allow).toEqual([1, 2]);
    expect(reloaded.cwd).toBe("/work");
    expect(reloaded.model).toBe("sonnet");
  });

  test("atomic writes chmod files to 0600", async () => {
    await saveStateAtomic(tmp, { threads: {} });
    const s = await stat(join(tmp, "state.json"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  test("atomic writes leave no temp files behind", async () => {
    await saveStateAtomic(tmp, { threads: {} });
    const glob = new Bun.Glob("state.json.tmp-*");
    const leftovers = await Array.fromAsync(glob.scan({ cwd: tmp }));
    expect(leftovers).toEqual([]);
  });
});
