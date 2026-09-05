import { OutputBudget } from "../../shared/OutputBudget";
import { Paths } from "../../shared/Paths";
import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView, ViewBlock } from "../../view/ViewBlock";
import type { GlobMatch } from "./glob";
import type {
  GlobDetails,
  GlobInput,
  GlobPathFormat,
  globSchema,
} from "./schema";

export type RenderOutcome = {
  readonly body: string;
  readonly totalItems: number;
  readonly visibleItems: number;
  readonly truncated: boolean;
};

export type RenderOptions = {
  readonly cwd: string;
  readonly pathFormat: GlobPathFormat;
};

export function renderFiles(
  matches: readonly GlobMatch[],
  headLimit: number,
  options: RenderOptions
): RenderOutcome {
  if (matches.length === 0) {
    return {
      body: "No matches.",
      totalItems: 0,
      visibleItems: 0,
      truncated: false,
    };
  }

  const lines = matches.map((match) => formatPath(match.path, options));
  const headCapped = lines.slice(0, headLimit);
  const { visible } = OutputBudget.applyByteCap(headCapped);
  const truncated = visible.length < lines.length;

  return {
    body: visible.join("\n"),
    totalItems: lines.length,
    visibleItems: visible.length,
    truncated,
  };
}

type GlobViewInput = ToolViewInput<typeof globSchema, GlobDetails>;

export function globView({ args, result, cwd }: GlobViewInput): ToolView {
  const input = (args ?? {}) as Partial<GlobInput>;
  return {
    label: "Glob",
    icon: "search",
    title: [
      {
        kind: "text",
        text: formatTitle({
          pattern: input.pattern,
          path: input.path,
          cwd,
          fileCount: result?.details?.fileCount,
        }),
      },
    ],
    body: formatBody(result),
  };
}

/**
 * The rendered listing is already baked into the result content by `execute`,
 * so replaying a persisted entry never re-resolves paths.
 */
function formatBody(result: GlobViewInput["result"]): readonly ViewBlock[] {
  const text = Renderer.firstText(result);
  if (text === "") {
    return [];
  }
  if (result?.details?.fileCount === 0) {
    return [{ kind: "text", text }];
  }
  return text.split("\n").map((path) => ({ kind: "file", path }));
}

type TitleOptions = {
  readonly pattern: string | undefined;
  readonly path: string | undefined;
  readonly cwd: string;
  readonly fileCount?: number;
};

function formatTitle(options: TitleOptions): string {
  const pattern = options.pattern ?? "...";
  const resolved =
    options.path === undefined
      ? undefined
      : Paths.resolve(options.path, options.cwd);
  const target =
    resolved === undefined || resolved === options.cwd
      ? undefined
      : Paths.displayRelative(resolved, options.cwd);
  const location = target ? ` in ${target}` : "";
  const suffix =
    options.fileCount === undefined
      ? ""
      : ` (${options.fileCount} ${options.fileCount === 1 ? "file" : "files"})`;
  return `${pattern}${location}${suffix}`;
}

function formatPath(path: string, options: RenderOptions): string {
  return options.pathFormat === "absolute"
    ? path
    : Paths.displayRelative(path, options.cwd);
}
