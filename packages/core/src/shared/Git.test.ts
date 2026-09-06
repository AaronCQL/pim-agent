import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Git } from "./Git";

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-footer-git-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("parseGitStatus", () => {
  test("parses clean branch status", () => {
    expect(
      Git.parseStatus(
        [
          "# branch.oid 123456",
          "# branch.head main",
          "# branch.upstream origin/main",
          "# branch.ab +0 -0",
        ].join("\n")
      )
    ).toEqual({
      branch: "main",
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
    });
  });

  test("counts one dirty path per entry, tracked or not", () => {
    expect(
      Git.parseStatus(
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
      dirtyCount: 2,
      ahead: 12,
      behind: 3,
    });
  });

  test("labels detached heads explicitly", () => {
    expect(Git.parseStatus("# branch.head (detached)\n")).toEqual({
      branch: "detached",
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
    });
  });
});

describe("fetchGitStatus", () => {
  test("returns empty git state outside a git repository", async () => {
    const root = await tempRoot();

    expect(await Git.fetchStatus(root)).toEqual(Git.EMPTY);
  });
});
