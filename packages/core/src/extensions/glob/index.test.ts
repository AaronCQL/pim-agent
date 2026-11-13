import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerGlob from "./index";
import type { GlobDetails, GlobInput } from "./schema";

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

/** A repository whose `.git/info/exclude` ignores each of `ignored`, every one a repository of its own. */
async function outerRepo(ignored: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pim-glob-index-"));
  tempRoots.push(root);
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await writeFile(
    join(root, ".git", "info", "exclude"),
    ignored.map((repo) => `${repo}/\n`).join("")
  );
  await writeFile(join(root, "outer.ts"), "");
  for (const repo of ignored) {
    await mkdir(join(root, repo, ".git"), { recursive: true });
    await writeFile(join(root, repo, "inner.ts"), "");
  }
  return root;
}

function glob(
  cwd: string,
  params: GlobInput
): Promise<AgentToolResult<GlobDetails>> {
  let tool: ToolDefinition | undefined;
  registerGlob({
    registerTool(def: ToolDefinition): void {
      tool = def;
    },
  } as unknown as ExtensionAPI);
  return tool!.execute("glob-1", params, undefined, undefined, {
    cwd,
  } as unknown as ExtensionToolContext) as Promise<
    AgentToolResult<GlobDetails>
  >;
}

function texts(result: AgentToolResult<GlobDetails>): readonly string[] {
  return result.content.map((block) =>
    block.type === "text" ? block.text : ""
  );
}

const FOOTER =
  "[glob tool: skipped nested repositories the enclosing repo ignores: inner, vendor/lib; pass one as path to search it.]";

describe("glob tool on ignored nested repositories", () => {
  test("ends with a footer naming them, after the matches", async () => {
    const root = await outerRepo(["inner", "vendor/lib"]);

    const result = await glob(root, { pattern: "**/*.ts" });

    expect(texts(result)).toEqual(["outer.ts", FOOTER]);
    expect(result.details.skippedRepos).toEqual(["inner", "vendor/lib"]);
  });

  test("names them when nothing matches", async () => {
    const root = await outerRepo(["inner", "vendor/lib"]);

    const result = await glob(root, { pattern: "**/*.md" });

    expect(texts(result)).toEqual(["No matches.", FOOTER]);
  });

  test("names none when ignored paths are searched too", async () => {
    const root = await outerRepo(["inner"]);

    const result = await glob(root, {
      pattern: "**/*.ts",
      includeIgnored: true,
    });

    expect(texts(result)).toHaveLength(1);
    expect(result.details.skippedRepos).toEqual([]);
  });

  test("searches one passed as path under its own rules", async () => {
    const root = await outerRepo(["inner"]);

    const result = await glob(root, { pattern: "**/*.ts", path: "inner" });

    expect(texts(result)).toEqual(["inner/inner.ts"]);
  });

  test("names ten of them, then counts the rest", async () => {
    const repos = Array.from(
      { length: 12 },
      (_, index) => `repo-${String(index + 1).padStart(2, "0")}`
    );
    const root = await outerRepo(repos);

    const result = await glob(root, { pattern: "**/*.ts" });

    expect(texts(result).at(-1)).toBe(
      `[glob tool: skipped nested repositories the enclosing repo ignores: ${repos.slice(0, 10).join(", ")}, and 2 more; pass one as path to search it.]`
    );
    expect(result.details.skippedRepos).toEqual(repos);
  });
});
