import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { runScript } from "#core/shared/fixtures/script";
import { Proc } from "#core/shared/Proc";
import { until } from "#core/shared/fixtures/wait";

const FIXTURE = join(import.meta.dir, "fixtures", "signalled.ts");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pim-daemon-signals-"));
});

afterEach(async () => {
  if (await Bun.file(join(home, "sleep.pid")).exists()) {
    try {
      process.kill(await sleepPid(), "SIGKILL");
    } catch {}
  }
  await rm(home, { recursive: true, force: true });
});

async function sleepPid(): Promise<number> {
  return Number(await Bun.file(join(home, "sleep.pid")).text());
}

test("SIGTERM stops every surface, then kills running bash commands, then exits cleanly", async () => {
  const daemon = runScript(FIXTURE, [home, "slow"]);
  await daemon.printed("ready");
  const sleep = await sleepPid();

  process.kill(daemon.pid, "SIGTERM");
  await daemon.printed("surface stopping");
  expect(Proc.isAlive(sleep)).toBe(true);
  process.kill(daemon.pid, "SIGUSR2");

  expect(await daemon.exited).toBe(0);
  expect(daemon.stdout().split("\n")).toEqual([
    "[daemon] serving web",
    "ready",
    "[daemon] SIGTERM: stopping",
    "surface stopping",
    "surface stopped",
    "",
  ]);
  await until(() => !Proc.isAlive(sleep), "the bash command to be killed");
});

test("a second signal while stopping exits at once, still killing bash commands", async () => {
  const daemon = runScript(FIXTURE, [home, "hang"]);
  await daemon.printed("ready");
  const sleep = await sleepPid();

  process.kill(daemon.pid, "SIGTERM");
  await daemon.printed("surface stopping");
  process.kill(daemon.pid, "SIGINT");

  expect(await daemon.exited).toBe(130);
  await until(() => !Proc.isAlive(sleep), "the bash command to be killed");
});
