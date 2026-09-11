import { describe, expect, test } from "bun:test";
import { HTTPError } from "ky";

import { createKy } from "./Http";

describe("createKy", () => {
  test("does not retry a rate-limited GET", async () => {
    let calls = 0;
    const controller = new AbortController();
    const client = createKy(async () => {
      calls += 1;
      return new Response("slow down", {
        status: 429,
        headers: { "retry-after": "3600" },
      });
    });

    const stalled = Symbol("stalled");
    const request = client("https://example.invalid/", {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    const outcome = await Promise.race([
      request,
      Bun.sleep(50).then(() => stalled),
    ]);
    controller.abort();

    expect(outcome).toBeInstanceOf(HTTPError);
    expect(calls).toBe(1);
  });
});
