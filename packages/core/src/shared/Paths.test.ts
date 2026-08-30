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

  test("returns a path relative to cwd when within cwd", () => {
    expect(Paths.titleOr("/work/src/file.ts", "/work")).toBe("src/file.ts");
  });

  test("returns the absolute path when outside cwd", () => {
    expect(Paths.titleOr("/other/file.ts", "/work")).toBe("/other/file.ts");
  });
});
