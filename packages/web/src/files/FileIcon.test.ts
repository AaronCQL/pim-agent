import { expect, test } from "bun:test";

import { FileIcon } from "./FileIcon";

test("file picks the specific group before falling back to code", () => {
  expect(
    Object.fromEntries(
      [
        "README.md",
        "package.json",
        "build.sh",
        "logo.svg",
        "App.ts",
        "Main.hs",
        "build.zig",
        ".oxfmtrc.json",
        ".npmrc",
        ".env.local",
        "bun.lock",
        "Dockerfile",
        "README",
      ].map((name) => [name, FileIcon.file(name)])
    )
  ).toEqual({
    "README.md": "i-griddy-icons:file-text",
    "package.json": "i-griddy-icons:settings",
    "build.sh": "i-griddy-icons:terminal",
    "logo.svg": "i-griddy-icons:image",
    "App.ts": "i-griddy-icons:file-code",
    "Main.hs": "i-griddy-icons:file-code",
    "build.zig": "i-griddy-icons:file-code",
    ".oxfmtrc.json": "i-griddy-icons:settings",
    ".npmrc": "i-griddy-icons:settings",
    ".env.local": "i-griddy-icons:key",
    "bun.lock": "i-griddy-icons:lock",
    Dockerfile: "i-griddy-icons:package",
    README: "i-griddy-icons:file",
  });
});
