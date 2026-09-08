import { Format } from "../../shared/Format";
import { Renderer } from "../../shared/Renderer";
import { SearchRender, type SearchList } from "../../shared/SearchRender";
import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView, ViewBlock } from "../../view/ViewBlock";
import type { GlobMatch } from "./glob";
import type {
  GlobDetails,
  GlobInput,
  GlobPathFormat,
  globSchema,
} from "./schema";

export type RenderOutcome = SearchList;

export type RenderOptions = {
  readonly cwd: string;
  readonly pathFormat: GlobPathFormat;
};

export function renderFiles(
  matches: readonly GlobMatch[],
  headLimit: number,
  options: RenderOptions
): RenderOutcome {
  return SearchRender.capList(
    matches.map((match) => SearchRender.formatPath(match.path, options)),
    headLimit
  );
}

type GlobViewInput = ToolViewInput<typeof globSchema, GlobDetails>;

export function globView({ args, result, cwd }: GlobViewInput): ToolView {
  const input = (args ?? {}) as Partial<GlobInput>;
  const fileCount = result?.details?.fileCount;
  return {
    label: "Glob",
    icon: "search",
    title: [
      {
        kind: "text",
        text: SearchRender.subjectTitle({
          subject: input.pattern ?? "...",
          path: input.path,
          cwd,
        }),
      },
      ...(fileCount === undefined
        ? []
        : ([
            {
              kind: "text",
              tone: "muted",
              text: Format.count(fileCount, "file"),
            },
          ] as const)),
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
