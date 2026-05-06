import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Renderer } from "../../shared/Renderer";
import {
  buildDiffComponent,
  buildWriteTitle,
  countDiffStats,
  type DiffStats,
  formatTitlePath,
} from "./render";
import { Paths } from "../../shared/Paths";
import { type WriteInput, writeSchema } from "./schema";
import { writeContent, type WriteOutcome } from "./write";

type WriteDetails = {
  readonly absolutePath: string;
  readonly bytesWritten: number;
  readonly created: boolean;
};

type WriteRenderState = {
  titleComponent?: Text;
  path?: string;
  stats: DiffStats;
};

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "write",
    label: "write",
    description:
      "Write whole UTF-8 text content to a file path. Creates the file (and parent directories) if missing, otherwise overwrites it. Returns a structured diff against the prior content.",
    promptSnippet: "Create or overwrite text files.",
    promptGuidelines: ["Use write only for new files or full rewrites."],
    parameters: writeSchema,
    renderShell: "self",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { path, content } = params as WriteInput;

      if (signal?.aborted) {
        throw new Error("Write aborted before execution.");
      }

      const absolutePath = Paths.resolve(path, ctx.cwd);
      const outcome = await writeContent(absolutePath, content);

      const summary = formatSummary(path, outcome);
      const details: WriteDetails & {
        readonly diff?: WriteOutcome["diff"];
      } = {
        absolutePath: outcome.absolutePath,
        bytesWritten: outcome.bytesWritten,
        created: outcome.created,
        ...(outcome.diff === undefined ? {} : { diff: outcome.diff }),
      };

      return {
        content: [{ type: "text", text: summary }],
        details,
      };
    },
    renderCall(args, theme, context) {
      const state = context.state as WriteRenderState;
      state.stats ??= { added: 0, removed: 0 };
      const rawPath = typeof args?.path === "string" ? args.path : undefined;
      const display = formatTitlePath(rawPath, context.cwd);
      state.path = display;
      const markerColor = Renderer.markerColorFor(
        Boolean(context.isPartial),
        Boolean(context.isError)
      );
      const text = buildWriteTitle({
        path: display,
        stats: state.stats,
        theme,
        markerColor,
        lastComponent: context.lastComponent,
      });
      state.titleComponent = text;
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as WriteRenderState;
      state.stats ??= { added: 0, removed: 0 };
      const fallback =
        (context.lastComponent as Container | undefined) ?? new Container();

      if (options.isPartial) {
        fallback.clear();
        return fallback;
      }

      if (context.isError) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(theme.fg("error", extractErrorText(result)));
        return text;
      }

      const details = result.details as
        | { readonly diff?: WriteOutcome["diff"] }
        | undefined;
      const diff = details?.diff;
      const stats = countDiffStats(diff);
      state.stats = stats;

      if (state.titleComponent && state.path !== undefined) {
        const markerColor = Renderer.markerColorFor(false, false);
        buildWriteTitle({
          path: state.path,
          stats,
          theme,
          markerColor,
          lastComponent: state.titleComponent,
        });
      }

      if (!diff) {
        fallback.clear();
        return fallback;
      }

      return buildDiffComponent({
        diff,
        theme,
        lastComponent: context.lastComponent,
      });
    },
  });
}

function formatSummary(path: string, outcome: WriteOutcome): string {
  const verb = outcome.created ? "Created" : "Wrote";

  if (outcome.diff === undefined && !outcome.created) {
    return `Wrote ${outcome.bytesWritten} bytes to ${path} (no changes).`;
  }

  return `${verb} ${outcome.bytesWritten} bytes at ${path}.`;
}

function extractErrorText(result: {
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
}): string {
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();

  return text || "Write failed.";
}
