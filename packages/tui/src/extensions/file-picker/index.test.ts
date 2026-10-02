import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { FileCandidate } from "#core/picker/catalog";
import { InProcessFilePickerSuggestionEngine } from "#core/picker/InProcessFilePickerSuggestionEngine";
import { WorkerFilePickerSuggestionEngine } from "#core/picker/WorkerFilePickerSuggestionEngine";
import { createFilePickerProviderFactory } from "./index";

const file = (path: string): FileCandidate => ({
  insertPath: path,
  displayPath: path,
  matchHaystack: path,
  isDirectory: false,
});

const currentProvider: AutocompleteProvider = {
  async getSuggestions() {
    return null;
  },
  applyCompletion(lines, cursorLine, cursorCol) {
    return { lines, cursorLine, cursorCol };
  },
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const createTestFactory = (
  loadRelativeCatalog: () => Promise<readonly FileCandidate[]>
) =>
  createFilePickerProviderFactory({
    engine: new InProcessFilePickerSuggestionEngine({ loadRelativeCatalog }),
  });

/** Suggestions for `line` with the cursor at its end. */
async function suggest(
  provider: AutocompleteProvider,
  line: string
): Promise<readonly string[] | null> {
  const answer = await provider.getSuggestions([line], 0, line.length, {
    signal: new AbortController().signal,
  });
  return answer && answer.items.map((item) => item.value);
}

function counting(load: () => Promise<readonly FileCandidate[]>) {
  const counter = { loads: 0 };
  const factory = createTestFactory(() => {
    counter.loads += 1;
    return load();
  });
  return { counter, provider: factory(currentProvider) };
}

test("entering @ starts one background relative catalog refresh", async () => {
  let catalog: readonly FileCandidate[] = [file("old.ts")];
  const { counter, provider } = counting(async () => catalog);

  expect(counter.loads).toBe(0);
  expect(await suggest(provider, "@")).toBeNull();
  expect(counter.loads).toBe(1);

  await flushPromises();
  expect(await suggest(provider, "@old")).toContain("@old.ts");

  catalog = [file("new.ts")];
  await suggest(provider, "@new");
  expect(counter.loads).toBe(1);
});

test("worker engine refreshes and ranks off the main thread", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pim-file-picker-worker-"));
  const engine = new WorkerFilePickerSuggestionEngine(workspace);
  try {
    await Bun.write(join(workspace, "worker-file.ts"), "");

    await engine.refreshRelative();
    const items = await engine.rank("worker", { limit: 50 });

    expect(items?.map((item) => item.value)).toContain("worker-file.ts");
  } finally {
    engine.dispose();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("a new @ token refreshes the relative catalog after using the session cache", async () => {
  let catalog: readonly FileCandidate[] = [file("old.ts")];
  const { counter, provider } = counting(async () => catalog);

  await suggest(provider, "@old");
  await flushPromises();

  catalog = [file("new.ts")];
  await suggest(provider, "plain text");
  expect(await suggest(provider, "@new")).toBeNull();
  expect(counter.loads).toBe(2);

  await flushPromises();
  expect(await suggest(provider, "@new")).toContain("@new.ts");
  expect(counter.loads).toBe(2);
});

test("relative catalog cache survives provider rebuilds", async () => {
  const factory = createTestFactory(async () => [file("old.ts")]);

  await suggest(factory(currentProvider), "@old");
  await flushPromises();

  expect(await suggest(factory(currentProvider), "@old")).toContain("@old.ts");
});

test("a new @ token while a refresh is in flight reuses that refresh", async () => {
  let resolveLoad: ((catalog: readonly FileCandidate[]) => void) | undefined;
  const { counter, provider } = counting(
    () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
  );

  await suggest(provider, "@a");
  await suggest(provider, "@ab");
  await suggest(provider, "plain text");
  await suggest(provider, "@b");

  expect(counter.loads).toBe(1);
  resolveLoad?.([file("b.ts")]);
  await flushPromises();
});

test("refresh failure preserves the last good relative cache", async () => {
  let shouldFail = false;
  const { provider } = counting(async () => {
    if (shouldFail) {
      throw new Error("boom");
    }
    return [file("old.ts")];
  });

  await suggest(provider, "@old");
  await flushPromises();
  shouldFail = true;
  await suggest(provider, "plain text");
  await suggest(provider, "@old");
  await flushPromises();

  expect(await suggest(provider, "@old")).toContain("@old.ts");
});

test.each([
  ["see @src/f please", 10, "@src/foo.ts", "@src/f", "see @src/foo.ts please"],
  ["@sr", 3, "@src/", "@sr", "@src/"],
])(
  "applying an @ completion adds no trailing space (%p)",
  (line, cursorCol, value, prefix, expected) => {
    const provider = createTestFactory(async () => [])(currentProvider);

    const result = provider.applyCompletion(
      [line],
      0,
      cursorCol,
      { value, label: value },
      prefix
    );

    expect(result.lines).toEqual([expected]);
    expect(result.cursorCol).toBe(expected.indexOf(value) + value.length);
  }
);

test("non-@ completions are delegated to the wrapped provider", () => {
  let delegated = false;
  const provider = createTestFactory(async () => [])({
    ...currentProvider,
    applyCompletion(lines, cursorLine, cursorCol) {
      delegated = true;
      return { lines, cursorLine, cursorCol };
    },
  });

  provider.applyCompletion(
    ["/mod"],
    0,
    4,
    { value: "model", label: "model" },
    "/mod"
  );

  expect(delegated).toBe(true);
});

test("absolute @ autocomplete also refreshes the relative catalog", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pim-file-picker-absolute-"));
  try {
    const { counter, provider } = counting(async () => [file("old.ts")]);

    await suggest(provider, `@${workspace}`);

    expect(counter.loads).toBe(1);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});
