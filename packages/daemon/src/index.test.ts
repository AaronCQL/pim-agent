import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { Daemon, type Surface } from "./Daemon";
import { build } from "./index";
import type { SurfaceName } from "./Surfaces";

type Case = readonly [ReadonlyArray<string>, SurfaceName[]];

let tmp: string;
let savedToken: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-daemon-test-"));
  savedToken = process.env.PIM_TELEGRAM_BOT_TOKEN;
  delete process.env.PIM_TELEGRAM_BOT_TOKEN;
});

afterEach(async () => {
  if (savedToken === undefined) {
    delete process.env.PIM_TELEGRAM_BOT_TOKEN;
  } else {
    process.env.PIM_TELEGRAM_BOT_TOKEN = savedToken;
  }
  await rm(tmp, { recursive: true, force: true });
});

test.each<Case>([
  [
    ["--mode", "daemon"],
    ["web", "telegram"],
  ],
  [["--mode", "web"], ["web"]],
  [["--mode", "telegram"], ["telegram"]],
  [["--mode", "daemon", "--surfaces", "telegram"], ["telegram"]],
])("%p builds the %p surfaces and no others", (args, expected) => {
  expect(build(args).map((surface) => surface.name)).toEqual(expected);
});

test("a telegram surface with no token anywhere leaves the web surface serving", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  let serving = false;
  const web: Surface = {
    name: "web",
    start: async () => {
      serving = true;
      return { stop: async () => {} };
    },
  };
  const [telegram] = build(["--mode", "telegram", "--config-dir", tmp]);
  const daemon = new Daemon([web, telegram!]);

  expect(await daemon.start()).toEqual(["web"]);
  expect(serving).toBe(true);
  expect(String(errors.mock.calls[0]?.[1])).toContain("Bot token required");
  errors.mockRestore();

  await daemon.stop();
});
