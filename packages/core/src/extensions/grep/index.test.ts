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
import registerGrep from "./index";
import type { GrepInput } from "./schema";

type GrepResult = AgentToolResult<{ readonly skippedRepos: readonly string[] }>;

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

/** A repository holding `outer.ts` whose `.git/info/exclude` ignores `inner`, a repository of its own holding `inner.ts`. */
async function outerRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pim-grep-index-"));
  tempRoots.push(root);
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await writeFile(join(root, ".git", "info", "exclude"), "inner/\n");
  await writeFile(join(root, "outer.ts"), "needle");
  await mkdir(join(root, "inner", ".git"), { recursive: true });
  await writeFile(join(root, "inner", "inner.ts"), "needle");
  return root;
}

function grep(cwd: string, params: GrepInput): Promise<GrepResult> {
  let tool: ToolDefinition | undefined;
  registerGrep({
    registerTool(def: ToolDefinition): void {
      tool = def;
    },
  } as unknown as ExtensionAPI);
  return tool!.execute("grep-1", params, undefined, undefined, {
    cwd,
  } as unknown as ExtensionToolContext) as Promise<GrepResult>;
}

function texts(result: GrepResult): readonly string[] {
  return result.content.map((block) =>
    block.type === "text" ? block.text : ""
  );
}

const FOOTER =
  "[grep tool: skipped nested repositories the enclosing repo ignores: inner; pass one as path to search it.]";

describe("grep tool on ignored nested repositories", () => {
  test("ends with a footer naming them, after the matches", async () => {
    const root = await outerRepo();

    const result = await grep(root, { pattern: "needle" });

    expect(texts(result)).toEqual(["outer.ts", FOOTER]);
    expect(result.details.skippedRepos).toEqual(["inner"]);
  });

  test("names them when nothing matches", async () => {
    const root = await outerRepo();

    const result = await grep(root, { pattern: "haystack" });

    expect(texts(result)).toEqual(["No matches.", FOOTER]);
  });

  test("names none when ignored paths are searched too", async () => {
    const root = await outerRepo();

    const result = await grep(root, {
      pattern: "needle",
      includeIgnored: true,
    });

    const [body, ...footers] = texts(result);
    expect(body!.split("\n").toSorted()).toEqual([
      "inner/inner.ts",
      "outer.ts",
    ]);
    expect(footers).toEqual([]);
    expect(result.details.skippedRepos).toEqual([]);
  });

  test("names none when the target is a single file", async () => {
    const root = await outerRepo();

    const result = await grep(root, { pattern: "needle", path: "outer.ts" });

    expect(texts(result)).toEqual(["outer.ts"]);
  });

  test("names none an exclude already rules out", async () => {
    const root = await outerRepo();

    const result = await grep(root, {
      pattern: "needle",
      exclude: ["inner/**"],
    });

    expect(texts(result)).toEqual(["outer.ts"]);
  });
});
