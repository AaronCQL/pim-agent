import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Paths } from "../../shared/Paths";
import {
  Renderer,
  type StatefulToolCallTitleContext,
  type StatefulToolCallTitleState,
} from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { findFiles } from "./glob";
import { formatTitle, renderFiles } from "./render";
import {
  GLOB_HEAD_LIMIT_MAX,
  type GlobInput,
  type GlobPathFormat,
  globSchema,
} from "./schema";

const PREVIEW_LINES = 10;
const DEFAULT_PATH_FORMAT: GlobPathFormat = "relative";

type GlobCallState = StatefulToolCallTitleState & {
  fileCount?: number;
};

type GlobRenderContext = StatefulToolCallTitleContext & {
  readonly args?: GlobInput;
  readonly cwd: string;
};

function renderTitle(
  input: Partial<GlobInput>,
  theme: Theme,
  context: GlobRenderContext
) {
  const state = context.state as GlobCallState;
  const title = formatTitle({
    pattern: input.pattern,
    path: input.path,
    cwd: context.cwd,
    fileCount: state.fileCount,
  });
  return Renderer.renderStatefulToolCallTitle({
    label: "Glob",
    title,
    theme,
    context,
  });
}

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "glob",
    label: "glob",
    description:
      "Find files by glob pattern under a directory, sorted newest first. " +
      "Skips gitignored paths and dotfiles unless requested. " +
      "Use glob to enumerate files instead of bash with find, fd, ls -R, or similar.",
    parameters: globSchema,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const {
        pattern,
        path,
        exclude,
        includeDotfiles,
        includeIgnored,
        pathFormat,
        headLimit,
      } = params as GlobInput;

      if (signal?.aborted) {
        throw new Error("Glob aborted before execution.");
      }

      const limit = headLimit ?? GLOB_HEAD_LIMIT_MAX;
      const resolvedPathFormat = pathFormat ?? DEFAULT_PATH_FORMAT;
      const absolutePath = Paths.resolve(path ?? ".", ctx.cwd);
      const matches = await findFiles(absolutePath, pattern, {
        exclude,
        includeDotfiles: includeDotfiles ?? false,
        includeIgnored: includeIgnored ?? false,
      });
      const outcome = renderFiles(matches, limit, {
        cwd: ctx.cwd,
        pathFormat: resolvedPathFormat,
      });
      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: outcome.body },
      ];

      if (outcome.truncated) {
        content.push({
          type: "text",
          text: `[glob tool: showing ${outcome.visibleItems} of ${outcome.totalItems} entries; narrow the pattern or scope to a specific path to reduce results.]`,
        });
      }

      return {
        content,
        details: {
          absolutePath,
          pattern,
          exclude,
          includeDotfiles: includeDotfiles ?? false,
          includeIgnored: includeIgnored ?? false,
          pathFormat: resolvedPathFormat,
          fileCount: matches.length,
          totalItems: outcome.totalItems,
          visibleItems: outcome.visibleItems,
          truncated: outcome.truncated,
        },
      };
    },
    renderCall(args, theme, context) {
      return renderTitle((args ?? {}) as Partial<GlobInput>, theme, context);
    },
    renderResult(result, options, theme, context) {
      const state = context.state as GlobCallState;
      const details = result.details as
        | { readonly fileCount?: number }
        | undefined;

      if (details?.fileCount !== undefined) {
        state.fileCount = details.fileCount;
        renderTitle(context.args ?? {}, theme, context);
      }

      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context,
        previewLines: PREVIEW_LINES,
      });
    },
  });
}
