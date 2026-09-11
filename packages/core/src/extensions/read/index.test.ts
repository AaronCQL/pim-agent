import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { usePimHome } from "../../shared/fixtures/home";
import {
  animatedGif,
  png,
  RESIZE_TIMEOUT_MS,
} from "../../shared/fixtures/images";
import { Images } from "../../shared/Images";
import { PimSettings } from "../../shared/PimSettings";
import registerRead from "./index";
import type { ReadDetails } from "./schema";

const home = usePimHome("pim-read-index-");

function registeredTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  registerRead({
    registerTool(def: ToolDefinition): void {
      tool = def;
    },
  } as unknown as ExtensionAPI);

  if (tool === undefined) {
    throw new Error("read tool was not registered");
  }
  return tool;
}

const visionModel = { id: "anthropic/claude", input: ["text", "image"] };
const textOnlyModel = { id: "openai/o3-mini", input: ["text"] };

/** One registered tool is one session, which is one dedup memory. */
function session(): (
  path: string,
  model?: unknown
) => Promise<AgentToolResult<ReadDetails>> {
  const tool = registeredTool();
  return (path, model = visionModel) =>
    tool.execute("read-1", { path }, undefined, undefined, {
      cwd: home.path,
      model,
    } as unknown as ExtensionContext) as Promise<AgentToolResult<ReadDetails>>;
}

function call(
  path: string,
  model: unknown = visionModel
): Promise<AgentToolResult<ReadDetails>> {
  return session()(path, model);
}

function images(result: AgentToolResult<ReadDetails>): number {
  return result.content.filter((block) => block.type === "image").length;
}

describe("read tool on text", () => {
  test("returns the LINE:CONTENT body and text details unchanged", async () => {
    const path = join(home.path, "greeter.ts");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const result = await call(path);
    expect(result.content).toEqual([
      { type: "text", text: "1:alpha\n2:beta\n3:gamma" },
    ]);
    expect(result.details).toEqual({
      kind: "text",
      absolutePath: path,
      totalLines: 3,
      visibleStart: 1,
      visibleEnd: 3,
      truncatedByByteCap: false,
      truncatedByEnd: false,
      hadBom: false,
    });
  });

  test("keeps the continuation footer as its own block", async () => {
    const path = join(home.path, "paged.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    const result = await registeredTool().execute(
      "read-2",
      { path, start: 1, end: 1 },
      undefined,
      undefined,
      { cwd: home.path, model: visionModel } as unknown as ExtensionContext
    );
    expect(result.content).toEqual([
      { type: "text", text: "1:alpha" },
      {
        type: "text",
        text: "[read tool: showing lines 1-1 of 3; call read again with start=2 to continue.]",
      },
    ]);
  });
});

describe("read tool on images", () => {
  test(
    "returns the resize note ahead of the picture",
    async () => {
      const path = join(home.path, "wide.png");
      await Bun.write(path, png(2400, 600));

      const result = await call(path);
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({
        type: "text",
        text: "image resized from 2400x600 to 2000x500; multiply coordinates by 1.20 to map to the original.",
      });
      expect(result.content[1]?.type).toBe("image");

      const details = result.details;
      expect(details?.kind).toBe("image");
      if (details?.kind !== "image") {
        return;
      }
      expect(details).toEqual({
        kind: "image",
        absolutePath: path,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        mimeType: expect.stringMatching(/^image\//),
        width: 2000,
        height: 500,
        bytes: expect.any(Number),
        resized: true,
        frames: 1,
      });
    },
    RESIZE_TIMEOUT_MS
  );

  test("sends a small picture on its own, with no note", async () => {
    const path = join(home.path, "icon.png");
    await Bun.write(path, png(48, 32));

    const result = await call(path);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "image",
      data: Buffer.from(png(48, 32)).toString("base64"),
      mimeType: "image/png",
    });
    expect(result.details?.kind).toBe("image");
  });

  test("never reports a picture as a binary file", async () => {
    const path = join(home.path, "no-extension");
    await Bun.write(path, png(16, 16));

    expect((await call(path)).details?.kind).toBe("image");
  });

  test("reports the frames an animation cannot show, and counts them in details", async () => {
    const path = join(home.path, "spin.gif");
    await Bun.write(path, animatedGif(3));

    const result = await call(path);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "animated gif: 3 frames, 1x1; frame 1 shown.",
    });
    expect(result.content[1]?.type).toBe("image");

    const details = result.details;
    if (details?.kind !== "image") {
      throw new Error(`expected an image read, got ${details?.kind}`);
    }
    expect(details.frames).toBe(3);
    expect(details.mimeType).toBe("image/gif");
  });

  test("names what a file with an image extension really holds", async () => {
    const path = join(home.path, "chart.png");
    await writeFile(path, "<!DOCTYPE html>\n<html>404</html>", "utf8");

    await expect(call(path)).rejects.toThrow(
      `File has an image extension but its content is not a valid PNG/JPEG/GIF/WebP. Detected: HTML document. This usually means a download saved an error page instead of the image. Use bash: file ${path}`
    );
  });

  test("refuses a source file too large to decode, on its size alone", async () => {
    const path = join(home.path, "huge.png");
    const huge = new Uint8Array(Images.MAX_SOURCE_BYTES + 1);
    huge.set(png(4, 4));
    await Bun.write(path, huge);

    await expect(call(path)).rejects.toThrow(
      "Image is 25 MB, over the 25 MB read cap."
    );
  });

  test("refuses to burn a turn on a model without vision", async () => {
    const path = join(home.path, "gate.png");
    await Bun.write(path, png(16, 16));

    await expect(call(path, textOnlyModel)).rejects.toThrow(
      `Cannot read images: the current model (openai/o3-mini) has no vision input. Switch models with /model, or inspect it with bash: file ${path}`
    );
  });

  test("reads the picture when no model is bound", async () => {
    const path = join(home.path, "unbound.png");
    await Bun.write(path, png(16, 16));

    expect((await call(path, undefined)).details?.kind).toBe("image");
  });
});

describe("read tool image dedup", () => {
  test("sends the picture once and points back at it the second time", async () => {
    const path = join(home.path, "loop.png");
    await Bun.write(path, png(24, 24));
    const read = session();

    const first = await read(path);
    const second = await read(path);

    expect(images(first)).toBe(1);
    expect(images(second)).toBe(0);
    expect(second.content).toEqual([
      {
        type: "text",
        text: `[read tool: ${path} is unchanged since it was read earlier in this conversation; use the image already above. Touch the file or read a different path to force a re-send.]`,
      },
    ]);
    expect(second.details).toEqual({
      ...first.details,
      deduped: true,
    } as ReadDetails);
  });

  test("re-sends the picture once the file is touched", async () => {
    const path = join(home.path, "touched.png");
    await Bun.write(path, png(24, 24));
    const read = session();

    const first = await read(path);
    const touched = new Date(Date.now() + 60_000);
    await utimes(path, touched, touched);
    const second = await read(path);

    expect(images(first)).toBe(1);
    expect(images(second)).toBe(1);
    expect(second.details).toEqual(first.details);
  });

  test("keeps every read separate for a session of its own", async () => {
    const path = join(home.path, "fresh.png");
    await Bun.write(path, png(24, 24));

    expect(images(await call(path))).toBe(1);
    expect(images(await call(path))).toBe(1);
  });

  test("never dedups with read.dedupImages off", async () => {
    const path = join(home.path, "opted-out.png");
    await Bun.write(path, png(24, 24));
    await PimSettings.set("read", { dedupImages: false });

    try {
      const read = session();
      expect(images(await read(path))).toBe(1);
      expect(images(await read(path))).toBe(1);
    } finally {
      await PimSettings.set("read", { dedupImages: true });
    }
  });

  test("leaves a repeated text read untouched", async () => {
    const path = join(home.path, "repeat.txt");
    await writeFile(path, "alpha\nbeta\n", "utf8");
    const read = session();

    const first = await read(path);
    const second = await read(path);

    expect(second.content).toEqual(first.content);
    expect(second.content).toEqual([{ type: "text", text: "1:alpha\n2:beta" }]);
    expect(second.details).toEqual(first.details);
  });
});
