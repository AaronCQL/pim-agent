import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { FileCandidate } from "./catalog";
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

const autocompleteOptions = (): { readonly signal: AbortSignal } => ({
  signal: new AbortController().signal,
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("relative @ autocomplete refreshes in the background after using the session cache", async () => {
  let catalog: readonly FileCandidate[] = [file("old.ts")];
  let loads = 0;
  const factory = createFilePickerProviderFactory({
    loadRelativeCatalog: async () => {
      loads += 1;
      return catalog;
    },
  });
  const provider = factory(currentProvider);

  await flushPromises();
  expect(loads).toBe(1);

  catalog = [file("new.ts")];
  const stale = await provider.getSuggestions(
    ["@new"],
    0,
    4,
    autocompleteOptions()
  );

  expect(stale).toBeNull();
  expect(loads).toBe(2);

  await flushPromises();
  const fresh = await provider.getSuggestions(
    ["@new"],
    0,
    4,
    autocompleteOptions()
  );

  expect(fresh?.items.map((item) => item.value)).toContain("@new.ts");
});

test("relative catalog cache survives provider rebuilds", async () => {
  let catalog: readonly FileCandidate[] = [file("old.ts")];
  const factory = createFilePickerProviderFactory({
    loadRelativeCatalog: async () => catalog,
  });
  const firstProvider = factory(currentProvider);

  await flushPromises();
  catalog = [file("new.ts")];
  await firstProvider.getSuggestions(["@new"], 0, 4, autocompleteOptions());
  await flushPromises();

  const rebuiltProvider = factory(currentProvider);
  const fresh = await rebuiltProvider.getSuggestions(
    ["@new"],
    0,
    4,
    autocompleteOptions()
  );

  expect(fresh?.items.map((item) => item.value)).toContain("@new.ts");
});

test("relative catalog refreshes are coalesced", async () => {
  let resolveLoad: ((catalog: readonly FileCandidate[]) => void) | undefined;
  let loads = 0;
  const factory = createFilePickerProviderFactory({
    loadRelativeCatalog: () => {
      loads += 1;
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    },
  });
  const provider = factory(currentProvider);

  await provider.getSuggestions(["@a"], 0, 2, autocompleteOptions());
  await provider.getSuggestions(["@ab"], 0, 3, autocompleteOptions());

  expect(loads).toBe(1);
  resolveLoad?.([file("ab.ts")]);
  await flushPromises();
});

test("refresh failure preserves the last good relative cache", async () => {
  let shouldFail = false;
  const factory = createFilePickerProviderFactory({
    loadRelativeCatalog: async () => {
      if (shouldFail) {
        throw new Error("boom");
      }
      return [file("old.ts")];
    },
  });
  const provider = factory(currentProvider);

  await flushPromises();
  shouldFail = true;
  await provider.getSuggestions(["@old"], 0, 4, autocompleteOptions());
  await flushPromises();

  const result = await provider.getSuggestions(
    ["@old"],
    0,
    4,
    autocompleteOptions()
  );

  expect(result?.items.map((item) => item.value)).toContain("@old.ts");
});

test("applying an @ file completion does not append a trailing space", () => {
  const factory = createFilePickerProviderFactory({
    loadRelativeCatalog: async () => [],
  });
  const provider = factory(currentProvider);

  const result = provider.applyCompletion(
    ["see @src/f please"],
    0,
    10,
    { value: "@src/foo.ts", label: "foo.ts" },
    "@src/f"
  );

  expect(result.lines).toEqual(["see @src/foo.ts please"]);
  expect(result.cursorCol).toBe("see @src/foo.ts".length);
});

test("applying an @ directory completion keeps the trailing slash and no space", () => {
  const factory = createFilePickerProviderFactory({
    loadRelativeCatalog: async () => [],
  });
  const provider = factory(currentProvider);

  const result = provider.applyCompletion(
    ["@sr"],
    0,
    3,
    { value: "@src/", label: "src/" },
    "@sr"
  );

  expect(result.lines).toEqual(["@src/"]);
  expect(result.cursorCol).toBe("@src/".length);
});

test("non-@ completions are delegated to the wrapped provider", () => {
  let delegated = false;
  const factory = createFilePickerProviderFactory({
    loadRelativeCatalog: async () => [],
  });
  const provider = factory({
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
    let loads = 0;
    const factory = createFilePickerProviderFactory({
      loadRelativeCatalog: async () => {
        loads += 1;
        return [file("old.ts")];
      },
    });
    const provider = factory(currentProvider);

    await flushPromises();
    expect(loads).toBe(1);

    await provider.getSuggestions(
      [`@${workspace}`],
      0,
      workspace.length + 1,
      autocompleteOptions()
    );

    expect(loads).toBe(2);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});
