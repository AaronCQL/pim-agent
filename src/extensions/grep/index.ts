import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Paths } from "../../shared/Paths";
import {
  Renderer,
  type StatefulToolCallTitleContext,
  type StatefulToolCallTitleState,
} from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { buildMatcher, findMatches } from "./grep";
import { formatTitle, renderMatches } from "./render";
import {
  GREP_HEAD_LIMIT_MAX,
  type GrepInput,
  type GrepOutputMode,
  type GrepPathFormat,
  grepSchema,
} from "./schema";

const PREVIEW_LINES = 10;
const DEFAULT_OUTPUT_MODE: GrepOutputMode = "files_with_matches";
const DEFAULT_PATH_FORMAT: GrepPathFormat = "relative";

type GrepCallState = StatefulToolCallTitleState & {
  fileCount?: number;
};

type GrepRenderContext = StatefulToolCallTitleContext & {
  readonly args?: GrepInput;
  readonly cwd: string;
};

function renderTitle(
  input: Partial<GrepInput>,
  theme: Theme,
  context: GrepRenderContext
) {
  const state = context.state as GrepCallState;
  const title = formatTitle({
    pattern: input.pattern,
    path: input.path,
    glob: input.glob,
    cwd: context.cwd,
    fileCount: state.fileCount,
  });
  return Renderer.renderStatefulToolCallTitle({
    label: "Grep",
    title,
    theme,
    context,
  });
}

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "grep",
    label: "grep",
    description:
      "Search UTF-8 text files with a JavaScript regex. Directory scans skip binary files, gitignored paths, and dotfiles unless requested; direct file paths are always searched. Use grep to search file contents instead of bash with grep, rg, ag, find -exec, or similar.",
    parameters: grepSchema,
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const {
        pattern,
        path,
        glob,
        exclude,
        outputMode,
        matchAcrossLines,
        context,
        includeDotfiles,
        includeIgnored,
        pathFormat,
        caseInsensitive,
        headLimit,
      } = params as GrepInput;

      if (signal?.aborted) {
        throw new Error("Grep aborted before execution.");
      }

      const resolvedPathFormat = pathFormat ?? DEFAULT_PATH_FORMAT;
      const resolvedContext = context ?? 0;
      const resolvedOutputMode = outputMode ?? DEFAULT_OUTPUT_MODE;
      const limit = Math.min(
        headLimit ?? GREP_HEAD_LIMIT_MAX,
        GREP_HEAD_LIMIT_MAX
      );
      const matcher = buildMatcher({
        pattern,
        caseInsensitive: caseInsensitive ?? false,
        matchAcrossLines: matchAcrossLines ?? false,
      });
      const absolutePath = Paths.resolve(path ?? ".", ctx.cwd);
      const matches = await findMatches(absolutePath, glob, matcher, {
        exclude,
        includeDotfiles: includeDotfiles ?? false,
        includeIgnored: includeIgnored ?? false,
      });
      const outcome = renderMatches(matches, resolvedOutputMode, limit, {
        cwd: ctx.cwd,
        pathFormat: resolvedPathFormat,
        context: resolvedContext,
      });
      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: outcome.body },
      ];

      if (outcome.truncated) {
        content.push({
          type: "text",
          text: `[grep tool: showing ${outcome.visibleItems} of ${outcome.totalItems} ${outcome.itemNoun}; narrow the pattern, scope to a specific path, or use a glob filter to reduce results.]`,
        });
      }

      return {
        content,
        details: {
          absolutePath,
          outputMode: resolvedOutputMode,
          exclude,
          matchAcrossLines: matchAcrossLines ?? false,
          context: resolvedContext,
          includeDotfiles: includeDotfiles ?? false,
          includeIgnored: includeIgnored ?? false,
          pathFormat: resolvedPathFormat,
          fileCount: outcome.fileCount,
          totalMatches: outcome.totalMatches,
          totalItems: outcome.totalItems,
          visibleItems: outcome.visibleItems,
          truncated: outcome.truncated,
        },
      };
    },
    renderCall(args, theme, context) {
      return renderTitle((args ?? {}) as Partial<GrepInput>, theme, context);
    },
    renderResult(result, options, theme, context) {
      const state = context.state as GrepCallState;
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
