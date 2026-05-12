import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EMPTY_GIT, fetchGitStatus, parseGitStatus } from "./git";

const tempRoot = (): Promise<string> =>
  mkdtemp(join(tmpdir(), "pim-footer-git-"));

describe("parseGitStatus", () => {
  test("parses clean branch status", () => {
    expect(
      parseGitStatus(
        [
          "# branch.oid 123456",
          "# branch.head main",
          "# branch.upstream origin/main",
          "# branch.ab +0 -0",
        ].join("\n")
      )
    ).toEqual({
      branch: "main",
      dirty: false,
      ahead: 0,
      behind: 0,
    });
  });

  test("parses dirty state and ahead/behind counts", () => {
    expect(
      parseGitStatus(
        [
          "# branch.oid 123456",
          "# branch.head feature/footer",
          "# branch.upstream origin/feature/footer",
          "# branch.ab +12 -3",
          "1 .M N... 100644 100644 100644 abc abc src/file.ts",
          "? scratch.txt",
        ].join("\n")
      )
    ).toEqual({
      branch: "feature/footer",
      dirty: true,
      ahead: 12,
      behind: 3,
    });
  });

  test("labels detached heads explicitly", () => {
    expect(parseGitStatus("# branch.head (detached)\n")).toEqual({
      branch: "detached",
      dirty: false,
      ahead: 0,
      behind: 0,
    });
  });
});

describe("fetchGitStatus", () => {
  test("returns empty git state outside a git repository", async () => {
    const root = await tempRoot();

    expect(await fetchGitStatus(root)).toEqual(EMPTY_GIT);
  });
});
