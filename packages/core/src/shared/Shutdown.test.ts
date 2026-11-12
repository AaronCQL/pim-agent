import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { runScript } from "./fixtures/script";

const FIXTURE = join(import.meta.dir, "fixtures", "shutdown.ts");

describe("Shutdown", () => {
  test("exit hooks run once each, past a broken one", async () => {
    const script = runScript(FIXTURE, ["hooks"]);
    expect(await script.exited).toBe(3);
    expect(script.stdout()).toBe("first\nlast\n");
  });

  test("an owned signal exits with its conventional code and runs the hooks, beside pi's own listeners", async () => {
    const script = runScript(FIXTURE, ["owned"]);
    await script.printed("ready");
    process.kill(script.pid, "SIGINT");
    expect(await script.exited).toBe(130);
    expect(script.stdout()).toBe("ready\nhook\n");
  });

  test("an owned signal another listener claims, as pi's suspend does, is left to it", async () => {
    const script = runScript(FIXTURE, ["suspended"]);
    await script.printed("ready");
    process.kill(script.pid, "SIGINT");
    await script.printed("ignored");
    process.kill(script.pid, "SIGINT");
    expect(await script.exited).toBe(130);
    expect(script.stdout()).toBe("ready\nignored\nhook\n");
  });

  test("requestStop reaches the signal owner", async () => {
    const script = runScript(FIXTURE, ["request"]);
    expect(await script.exited).toBe(0);
    expect(script.stdout()).toBe("owner got SIGTERM\n");
  });
});
