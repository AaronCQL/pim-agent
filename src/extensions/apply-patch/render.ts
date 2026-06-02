import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import type { ToolDiff } from "../../shared/DiffLines";
import {
  type DiffRenderState,
  type DiffStats,
  DiffView,
} from "../../shared/DiffView";
import { Paths } from "../../shared/Paths";
import { type RenderContext, Renderer } from "../../shared/Renderer";
import type { ApplyEntry } from "./executor";
import {
  ADD_FILE_MARKER,
  cleanPath,
  DELETE_FILE_MARKER,
  UPDATE_FILE_MARKER,
} from "./parser";

const ERROR_PREVIEW_LINES = 12;
// Rename separator. ➝ (U+279D) reads more vertically centered than → in most
// terminal fonts; swap here if a font renders it double-width.
const ARROW = "➝";

type ApplyPatchDetails = {
  readonly entries?: readonly ApplyEntry[];
};

type ApplyPatchRenderContext = RenderContext & {
  readonly cwd: string;
  readonly state: DiffRenderState;
};

type EntryView = {
  readonly label: string;
  readonly title: string;
  readonly stats: DiffStats;
  // Body to render under the title; undefined => title only (delete, rename).
  readonly body: ToolDiff | undefined;
};

// Draw an "Edit: <path>" title as soon as the call starts (mirroring the edit
// tool) so there's never a blank row and an error still gets a header. The
// title is for the first file and is updated in place on result.
export function renderApplyPatchCall(
  args: Record<string, unknown> | undefined,
  theme: Theme,
  context: ApplyPatchRenderContext
): Component {
  const input = typeof args?.input === "string" ? args.input : undefined;
  const firstPath = input ? affectedPaths(input)[0] : undefined;
  return DiffView.renderDiffCall({
    label: "Edit",
    rawPath: firstPath ? Paths.resolve(firstPath, context.cwd) : undefined,
    theme,
    context,
  });
}

function blankLine(): Component {
  return {
    render: () => [""],
    invalidate() {},
  };
}

function describeEntry(
  entry: ApplyEntry,
  cwd: string,
  theme: Theme
): EntryView {
  const rel = (p: string): string =>
    Paths.toForwardSlashes(Paths.displayRelative(Paths.resolve(p, cwd), cwd));
  const stats = DiffView.countStats(entry.diff);

  switch (entry.action.kind) {
    case "add":
      // A new file: reuse the write-tool look (green content body).
      return {
        label: "Write",
        title: rel(entry.action.path),
        stats,
        body: entry.diff,
      };
    case "delete":
      // Title only with a -N stat; don't dump the removed file as a red diff.
      return {
        label: "Delete",
        title: rel(entry.action.path),
        stats,
        body: undefined,
      };
    case "move":
      // A pure move has no body; a move with content changes still renders as an edit.
      return {
        label: entry.diff ? "Edit" : "Move",
        title: formatMoveTitle(
          rel(entry.action.path),
          rel(entry.action.movePath ?? entry.action.path),
          theme
        ),
        stats,
        body: entry.diff,
      };
    default:
      return {
        label: "Edit",
        title: rel(entry.action.path),
        stats,
        body: entry.diff,
      };
  }
}

function formatMoveTitle(
  oldPath: string,
  newPath: string,
  theme: Theme
): string {
  const oldParts = oldPath.split("/");
  const newParts = newPath.split("/");
  let commonPrefix = 0;

  while (
    commonPrefix < oldParts.length &&
    commonPrefix < newParts.length &&
    oldParts[commonPrefix] === newParts[commonPrefix]
  ) {
    commonPrefix += 1;
  }

  let commonSuffix = 0;
  while (
    commonSuffix < oldParts.length - commonPrefix &&
    commonSuffix < newParts.length - commonPrefix &&
    oldParts[oldParts.length - commonSuffix - 1] ===
      newParts[newParts.length - commonSuffix - 1]
  ) {
    commonSuffix += 1;
  }

  const oldChanged = oldParts.slice(
    commonPrefix,
    oldParts.length - commonSuffix
  );
  const newChanged = newParts.slice(
    commonPrefix,
    newParts.length - commonSuffix
  );

  if (
    oldChanged.length > 0 &&
    newChanged.length > 0 &&
    (commonPrefix > 0 ||
      commonSuffix > 0 ||
      (oldParts.length === 1 && newParts.length === 1))
  ) {
    const prefix =
      commonPrefix > 0 ? `${oldParts.slice(0, commonPrefix).join("/")}/` : "";
    const suffix =
      commonSuffix > 0 ? `/${oldParts.slice(-commonSuffix).join("/")}` : "";

    return (
      prefix +
      dim(theme, "{") +
      dim(theme, theme.strikethrough(oldChanged.join("/"))) +
      dim(theme, ` ${ARROW} `) +
      normalTitle(theme, newChanged.join("/")) +
      dim(theme, "}") +
      normalTitle(theme, suffix)
    );
  }

  return `${dim(theme, theme.strikethrough(oldPath))} ${dim(
    theme,
    ARROW
  )} ${normalTitle(theme, newPath)}`;
}

function dim(theme: Theme, text: string): string {
  return theme.fg("dim", text);
}

function normalTitle(theme: Theme, text: string): string {
  return text === "" ? "" : theme.fg("toolTitle", text);
}

export function renderApplyPatchResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ApplyPatchRenderContext
): Component {
  const state = context.state;
  const container =
    (context.lastComponent as Container | undefined) ?? new Container();
  container.clear();

  if (options.isPartial) {
    return container;
  }

  if (context.isError) {
    return Renderer.renderBorderedResult({
      result,
      options,
      theme,
      context: { ...context, isPartial: false },
      previewLines: ERROR_PREVIEW_LINES,
    });
  }

  const details = result.details as ApplyPatchDetails | undefined;
  // A no-op update (rewrote identical content) has nothing to show; skip it.
  const entries = (details?.entries ?? []).filter(
    (entry) => !(entry.action.kind === "update" && entry.diff === undefined)
  );
  const markerColor = Renderer.markerColorFor(false, false);

  entries.forEach((entry, index) => {
    const view = describeEntry(entry, context.cwd, theme);

    if (index === 0 && state?.titleComponent) {
      // Reuse the call title for the first file, updating it in place.
      DiffView.buildTitle({
        label: view.label,
        path: view.title,
        stats: view.stats,
        theme,
        markerColor,
        lastComponent: state.titleComponent,
      });
    } else {
      // A blank padding row separates each file from the previous one.
      if (index > 0) {
        container.addChild(blankLine());
      }
      container.addChild(
        DiffView.buildTitle({
          label: view.label,
          path: view.title,
          stats: view.stats,
          theme,
          markerColor,
          lastComponent: undefined,
        })
      );
    }

    if (view.body) {
      container.addChild(
        DiffView.buildBlock({
          diff: view.body,
          theme,
          lastComponent: undefined,
        })
      );
    }
  });

  container.invalidate();
  return container;
}

const FILE_MARKERS = [
  ADD_FILE_MARKER,
  DELETE_FILE_MARKER,
  UPDATE_FILE_MARKER,
] as const;

function affectedPaths(input: string): readonly string[] {
  const paths: string[] = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    for (const marker of FILE_MARKERS) {
      if (line.startsWith(marker)) {
        paths.push(cleanPath(line.slice(marker.length)));
        break;
      }
    }
  }
  return paths;
}
