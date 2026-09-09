import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Images } from "../../shared/Images";
import { Paths } from "../../shared/Paths";
import { Tools } from "../../shared/Tools";
import { unchangedImageNote } from "./image";
import { ImageMemory } from "./ImageMemory";
import { buildReadRange, readFile } from "./read";
import { readView } from "./render";
import { type ReadDetails, type ReadInput, readSchema } from "./schema";

export default function (pi: ExtensionAPI): void {
  const memory = new ImageMemory();

  Tools.register<typeof readSchema, ReadDetails>(pi, {
    name: "read",
    label: "read",
    description:
      "Read a local UTF-8 text file. " +
      "Output is `LINE:CONTENT` with no space after the colon. " +
      "Capped at 32KB per call; lines longer than 2000 chars are truncated. " +
      "Images (png, jpeg, gif, webp) are returned as pictures; they are downscaled to 2000px and the resize is reported. " +
      "An animated image shows frame 1 and reports its frame count.",
    parameters: readSchema,
    renderShell: "self",
    effect: { kind: "readOnly" },
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { path, start, end } = params as ReadInput;

      if (signal?.aborted) {
        throw new Error("Read aborted before execution.");
      }

      const range = buildReadRange(start, end);
      const absolutePath = Paths.resolve(path, ctx.cwd);
      const outcome = await readFile(absolutePath, range, {
        model: ctx.model,
        memory,
      });

      if (outcome.kind === "image") {
        return {
          content: Images.contentOf(
            outcome.image,
            Images.noteOf(outcome.image)
          ),
          details: outcome.details,
        };
      }

      if (outcome.kind === "image-unchanged") {
        return {
          content: [
            {
              type: "text",
              text: unchangedImageNote(outcome.details.absolutePath),
            },
          ],
          details: outcome.details,
        };
      }

      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: outcome.body },
      ];

      if (outcome.truncatedByEnd && outcome.nextStart !== undefined) {
        content.push({
          type: "text",
          text: `[read tool: showing lines ${outcome.visibleStart}-${outcome.visibleEnd} of ${outcome.totalLines}; call read again with start=${outcome.nextStart} to continue.]`,
        });
      }

      return {
        content,
        details: {
          kind: "text",
          absolutePath,
          totalLines: outcome.totalLines,
          visibleStart: outcome.visibleStart,
          visibleEnd: outcome.visibleEnd,
          truncatedByByteCap: outcome.truncatedByByteCap,
          truncatedByEnd: outcome.truncatedByEnd,
          hadBom: outcome.hadBom,
          nextStart: outcome.nextStart,
        },
      };
    },
    toViewModel: readView,
  });
}
