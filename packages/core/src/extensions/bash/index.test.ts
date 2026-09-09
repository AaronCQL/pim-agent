import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { usePimHome } from "../../shared/fixtures/home";
import { animatedGif, PNG_MAGIC, png } from "../../shared/fixtures/images";
import registerBash from "./index";
import type { BashDetails } from "./schema";

const home = usePimHome("pim-bash-index-");

function registeredTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  registerBash({
    registerTool(def: ToolDefinition): void {
      tool = def;
    },
  } as unknown as ExtensionAPI);

  if (tool === undefined) {
    throw new Error("bash tool was not registered");
  }
  return tool;
}

const visionModel = { id: "anthropic/claude", input: ["text", "image"] };
const textOnlyModel = { id: "openai/o3-mini", input: ["text"] };

function run(
  command: string,
  model: unknown = visionModel
): Promise<AgentToolResult<BashDetails>> {
  return registeredTool().execute("bash-1", { command }, undefined, undefined, {
    cwd: home.path,
    model,
  } as unknown as ExtensionContext) as Promise<AgentToolResult<BashDetails>>;
}

function textOf(result: AgentToolResult<BashDetails>): string[] {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text);
}

function images(
  result: AgentToolResult<BashDetails>
): { readonly mimeType: string }[] {
  return result.content.filter((block) => block.type === "image") as {
    mimeType: string;
  }[];
}

async function fileOf(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(home.path, name);
  await writeFile(path, bytes);
  return path;
}

describe("bash tool on text", () => {
  test("plain output is reported exactly as before", async () => {
    const result = await run("echo hi");

    expect(result.content).toEqual([
      { type: "text", text: "Exit code: 0\nstdout:\nhi" },
    ]);
    expect(result.details).toEqual({
      exitCode: 0,
      signal: null,
      durationMs: expect.any(Number),
      timedOut: false,
      aborted: false,
      stdout: { totalBytes: 3, truncated: false, path: null },
      stderr: { totalBytes: 0, truncated: false, path: null },
    });
  });

  test("binary that is not one of the four formats stays text", async () => {
    const path = await fileOf(
      "archive.zip",
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8])
    );

    const result = await run(`cat ${path}`);

    expect(images(result)).toEqual([]);
    expect(textOf(result)[0]).toContain("stdout:");
    expect(result.details?.image).toBeUndefined();
  });
});

describe("bash tool on stdout that is a picture", () => {
  test("returns the picture behind a placeholder, exit code intact", async () => {
    const path = await fileOf("shot.png", png(40, 30));

    const result = await run(`cat ${path}`);

    expect(textOf(result)[0]).toBe("Exit code: 0");
    expect(textOf(result)[1]).toMatch(
      /^\[bash tool: stdout is a 40x30 png \([\d.]+ (?:bytes|KB)\), shown as an image\.\]$/
    );
    expect(images(result)).toEqual([
      expect.objectContaining({ mimeType: "image/png" }),
    ]);
    expect(result.details?.image).toEqual({
      sha256: expect.any(String),
      mimeType: "image/png",
      width: 40,
      height: 30,
      bytes: expect.any(Number),
      resized: false,
      frames: 1,
    });
  });

  test("stderr and duration are still reported beside it", async () => {
    const path = await fileOf("noisy.png", png(8, 8));

    const result = await run(`cat ${path}; echo oops >&2`);

    expect(textOf(result)[0]).toBe("Exit code: 0\nstderr:\noops");
    expect(images(result)).toHaveLength(1);
  });

  test("a picture on stderr is a broken program, not a picture", async () => {
    const path = await fileOf("wrong-stream.png", png(8, 8));

    const result = await run(`cat ${path} >&2`);

    expect(images(result)).toEqual([]);
    expect(textOf(result)[0]).toContain("stderr:");
  });

  test("the placeholder names the frames an animation cannot show", async () => {
    const path = await fileOf("spin.gif", animatedGif(3));

    const result = await run(`cat ${path}`);

    expect(textOf(result)[1]).toMatch(
      /^\[bash tool: stdout is a 1x1 gif \([\d.]+ bytes\), shown as an image\. animated gif: 3 frames, 1x1; frame 1 shown\.\]$/
    );
    expect(images(result)).toEqual([
      expect.objectContaining({ mimeType: "image/gif" }),
    ]);
    expect(result.details?.image?.frames).toBe(3);
  });

  test("a model without vision is told, and the command still succeeds", async () => {
    const path = await fileOf("unseen.png", png(40, 30));

    const result = await run(`cat ${path}`, textOnlyModel);

    expect(images(result)).toEqual([]);
    expect(textOf(result)[1]).toMatch(
      /^\[bash tool: stdout is a 40x30 png \([\d.]+ (?:bytes|KB)\); the current model has no vision input\.\]$/
    );
    expect(result.details?.image?.width).toBe(40);
  });

  test("bytes that only claim to be a picture keep today's behaviour", async () => {
    const path = await fileOf(
      "liar.png",
      Uint8Array.from([...PNG_MAGIC, 9, 9, 9, 9])
    );

    const result = await run(`cat ${path}`);

    expect(images(result)).toEqual([]);
    expect(textOf(result)[0]).toContain(
      "[bash tool: stdout is 12 bytes of png data that could not be decoded as an image.]"
    );
    expect(result.details?.image).toBeUndefined();
  });
});
