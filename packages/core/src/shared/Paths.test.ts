import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Paths } from "./Paths";

describe("Paths.resolve", () => {
  test("resolves relative paths against base", () => {
    expect(Paths.resolve("foo.txt", "/work")).toBe("/work/foo.txt");
    expect(Paths.resolve("src/foo.ts", "/work")).toBe("/work/src/foo.ts");
  });

  test("expands ~ to home directory", () => {
    const home = homedir();
    expect(Paths.resolve("~", "/tmp")).toBe(home);
    expect(Paths.resolve("~/.config", "/tmp")).toBe(join(home, ".config"));
  });

  test("preserves absolute paths", () => {
    expect(Paths.resolve("/etc/hosts", "/tmp")).toBe("/etc/hosts");
  });
});

describe("Paths.displayRelative", () => {
  test("returns relative path when inside cwd", () => {
    expect(Paths.displayRelative("/work/src/foo.ts", "/work")).toBe(
      "src/foo.ts"
    );
  });

  test("returns absolute path when outside cwd", () => {
    expect(Paths.displayRelative("/etc/hosts", "/work")).toBe("/etc/hosts");
  });

  test("returns absolute path when cwd equals path", () => {
    expect(Paths.displayRelative("/work", "/work")).toBe("/work");
  });
});

describe("Paths.titleOr", () => {
  test("returns the placeholder when path is undefined", () => {
    expect(Paths.titleOr(undefined, "/work")).toBe("...");
  });
});

describe("Paths.within", () => {
  test("holds for the directory itself and anything below it, by whole segments", () => {
    expect(Paths.within("/work", "/work")).toBe(true);
    expect(Paths.within("/work", "/work/inner/a")).toBe(true);
    expect(Paths.within("/work", "/workshop")).toBe(false);
    expect(Paths.within("/work/inner", "/work")).toBe(false);
    expect(Paths.within("/work", "/other")).toBe(false);
  });
});

describe("Paths.isNormalRelative", () => {
  test("takes a plain relative path and nothing that climbs, roots or doubles up", () => {
    expect(Paths.isNormalRelative("inner")).toBe(true);
    expect(Paths.isNormalRelative("a/b.txt")).toBe(true);
    for (const path of [
      "",
      ".",
      "..",
      "./a",
      "a/",
      "a//b",
      "a/./b",
      "a/../b",
      "../a",
      "/etc",
      "a\\..\\..\\b",
    ]) {
      expect(Paths.isNormalRelative(path)).toBe(false);
    }
  });
});
