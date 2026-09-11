import { describe, expect, test } from "bun:test";
import { Languages } from "./Languages";

describe("Languages", () => {
  test("an extension, an alias and a canonical name all name one language", () => {
    expect(Languages.fromPath("src/App.tsx")).toBe("typescript");
    expect(Languages.resolve("ts")).toBe("typescript");
    expect(Languages.resolve("TypeScript")).toBe("typescript");
  });

  test("a file with no extension is looked up by its own name", () => {
    expect(Languages.fromPath("Dockerfile")).toBe("dockerfile");
    expect(Languages.fromPath("build/Makefile")).toBe("makefile");
  });

  test("a dotted directory does not make a path an extension", () => {
    expect(Languages.fromPath("/home/a.b/notes")).toBeUndefined();
  });

  test("what it does not know it leaves alone rather than guessing", () => {
    expect(Languages.fromPath("LICENSE")).toBeUndefined();
    expect(Languages.resolve("applescript")).toBeUndefined();
    expect(Languages.resolve(undefined)).toBeUndefined();
  });
});
