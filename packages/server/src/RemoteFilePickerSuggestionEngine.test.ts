import { expect, test } from "bun:test";

import type { PickerItem } from "../../core/src/picker/PickerItem";
import { RemoteFilePickerSuggestionEngine } from "./RemoteFilePickerSuggestionEngine";

function recorder(): {
  readonly queries: string[];
  readonly query: (q: string) => Promise<readonly PickerItem[]>;
} {
  const queries: string[] = [];
  return {
    queries,
    query: async (q) => {
      queries.push(q);
      await Bun.sleep(1);
      return [{ value: q, label: q }];
    },
  };
}

test("coalesces keystrokes into one round trip", async () => {
  const { queries, query } = recorder();
  const engine = new RemoteFilePickerSuggestionEngine(query, 20);

  const results = await Promise.all([
    engine.rank("s", { limit: 10 }),
    engine.rank("se", { limit: 10 }),
    engine.rank("ses", { limit: 10 }),
  ]);

  expect(queries).toEqual(["ses"]);
  expect(results.at(-1)).toEqual([{ value: "ses", label: "ses" }]);
  expect(results.slice(0, 2)).toEqual([[], []]);
});

test("answers a repeated query from cache", async () => {
  const { queries, query } = recorder();
  const engine = new RemoteFilePickerSuggestionEngine(query, 0);

  await engine.rank("src", { limit: 10 });
  await engine.rank("src", { limit: 10 });

  expect(queries).toEqual(["src"]);
});

test("refreshRelative drops the cache, so invalidation re-queries", async () => {
  const { queries, query } = recorder();
  const engine = new RemoteFilePickerSuggestionEngine(query, 0);

  await engine.rank("src", { limit: 10 });
  await engine.refreshRelative();
  await engine.rank("src", { limit: 10 });

  expect(queries).toEqual(["src", "src"]);
});

test("an aborted keystroke never reaches the server", async () => {
  const { queries, query } = recorder();
  const engine = new RemoteFilePickerSuggestionEngine(query, 10);
  const controller = new AbortController();

  const pending = engine.rank("src", {
    limit: 10,
    signal: controller.signal,
  });
  controller.abort();

  expect(await pending).toEqual([]);
  expect(queries).toEqual([]);
});
