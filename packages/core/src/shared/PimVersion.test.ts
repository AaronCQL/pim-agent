import { describe, expect, test } from "bun:test";

import { PimVersion } from "./PimVersion";

function registry(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("current", () => {
  test("reads the version of the running pim", async () => {
    expect(await PimVersion.current()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("pi", () => {
  test("reads the version of the bundled pi", async () => {
    expect(await PimVersion.pi()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("latest", () => {
  test("asks the registry for the package this pim was published as", async () => {
    let asked: string | undefined;
    const spy = (async (input: Request) => {
      asked = input.url;
      return new Response(JSON.stringify({ version: "1.2.3" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { name } = (await Bun.file(
      new URL("../../../../package.json", import.meta.url)
    ).json()) as { name: string };

    expect(await PimVersion.latest({ fetch: spy })).toBe("1.2.3");
    expect(asked).toBe(
      `https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`
    );
  });

  test("returns undefined when the registry answers without a version", async () => {
    expect(
      await PimVersion.latest({ fetch: registry({ version: 7 }) })
    ).toBeUndefined();
  });

  test("returns undefined on an error response", async () => {
    expect(
      await PimVersion.latest({ fetch: registry({}, 500) })
    ).toBeUndefined();
  });

  test("returns undefined when the request fails", async () => {
    const failing = (() => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await PimVersion.latest({ fetch: failing })).toBeUndefined();
  });
});

describe("isNewer", () => {
  test.each([
    ["0.10.0", "0.9.0", true],
    ["1.0.0", "0.9.9", true],
    ["0.9.1", "0.9.0", true],
    ["0.9.0", "0.9.0", false],
    ["0.9.0", "0.10.0", false],
    ["0.8.9", "0.9.0", false],
    ["0.9.0", "0.9.0-beta.1", true],
    ["0.9.0-beta.2", "0.9.0", false],
    ["nightly", "0.9.0", true],
    ["0.9.0", "0.9.0 ", false],
  ])("%s over %s is %s", (candidate, installed, expected) => {
    expect(PimVersion.isNewer(candidate, installed)).toBe(expected);
  });
});
