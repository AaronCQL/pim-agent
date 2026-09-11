import type { ToolDiff } from "../../shared/DiffLines";
import { Paths } from "../../shared/Paths";
import { PatchSummary } from "../../shared/PatchSummary";
import type { ToolViewInput } from "../../shared/Tools";
import { DiffBlocks } from "../../view/DiffBlocks";
import type { Span, ToolIcon, ToolView, ViewBlock } from "../../view/ViewBlock";
import type { ApplyEntry } from "./executor";
import { type applyPatchSchema, prepareApplyPatchArguments } from "./schema";

// Rename separator. ➝ (U+279D) reads more vertically centered than → in most
// terminal fonts; swap here if a font renders it double-width.
const ARROW = "➝";

export type ApplyPatchDetails = {
  readonly entries?: readonly ApplyEntry[];
};

export type ApplyPatchViewInput = ToolViewInput<
  typeof applyPatchSchema,
  ApplyPatchDetails
>;

type EntryView = {
  readonly label: string;
  readonly icon: ToolIcon;
  readonly title: readonly Span[];
  /** A composed rename title is not a plain path, so it is not a `file` block. */
  readonly path: string | undefined;
  readonly stats: readonly Span[];
  /** Diff to render under the title; undefined => title only (delete, rename). */
  readonly body: ToolDiff | undefined;
};

/**
 * The first file owns the row title (mirroring the edit tool) so there is never
 * a blank row and an error still gets a header; before the result settles the
 * title comes from the raw patch text. Every further file is appended to the
 * body as its own section.
 */
export function applyPatchView({
  args,
  result,
  cwd,
}: ApplyPatchViewInput): ToolView {
  const [first, ...rest] = visibleEntries(result?.details).map((entry) =>
    describeEntry(entry, cwd)
  );

  if (first === undefined) {
    return {
      label: "Edit",
      icon: "edit",
      title: [{ kind: "file", path: callPath(args, cwd) }],
    };
  }

  return {
    label: first.label,
    icon: first.icon,
    title: [titleBlock(first), ...statsBlocks(first)],
    body: [
      ...DiffBlocks.body(first.body),
      ...rest.flatMap((entry) => [
        sectionBlock(entry),
        ...DiffBlocks.body(entry.body),
      ]),
    ],
  };
}

/** A no-op update (rewrote identical content) has nothing to show; skip it. */
function visibleEntries(
  details: ApplyPatchDetails | undefined
): readonly ApplyEntry[] {
  return (details?.entries ?? []).filter(
    (entry) => !(entry.action.kind === "update" && entry.diff === undefined)
  );
}

/**
 * Normalizes first: a call streaming in can still be a bare patch string or
 * carry the text under an alias key, exactly as `prepareArguments` sees it.
 */
function callPath(
  args: ApplyPatchViewInput["args"] | undefined,
  cwd: string
): string {
  const prepared =
    args === undefined ? undefined : prepareApplyPatchArguments(args);
  const input =
    typeof prepared?.input === "string" ? prepared.input : undefined;
  const firstPath = input ? PatchSummary.firstPath(input) : undefined;
  return Paths.titleOr(
    firstPath ? Paths.resolve(firstPath, cwd) : undefined,
    cwd
  );
}

function describeEntry(entry: ApplyEntry, cwd: string): EntryView {
  const rel = (p: string): string =>
    Paths.toForwardSlashes(Paths.displayRelative(Paths.resolve(p, cwd), cwd));
  const stats = DiffBlocks.statSpans(entry.diff);
  const plain = (path: string): Pick<EntryView, "title" | "path"> => ({
    title: [{ text: rel(path) }],
    path: rel(path),
  });

  switch (entry.action.kind) {
    case "add":
      // A new file: reuse the write-tool look (green content body).
      return {
        label: "Write",
        icon: "edit",
        ...plain(entry.action.path),
        stats,
        body: entry.diff,
      };
    case "delete":
      // Title only with a -N stat; don't dump the removed file as a red diff.
      return {
        label: "Delete",
        icon: "trash",
        ...plain(entry.action.path),
        stats,
        body: undefined,
      };
    case "move":
      // A pure move has no body; a move with content changes renders as an edit.
      return {
        label: entry.diff ? "Edit" : "Move",
        icon: "edit",
        title: moveTitle(
          rel(entry.action.path),
          rel(entry.action.movePath ?? entry.action.path)
        ),
        path: undefined,
        stats,
        body: entry.diff,
      };
    default:
      return {
        label: "Edit",
        icon: "edit",
        ...plain(entry.action.path),
        stats,
        body: entry.diff,
      };
  }
}

function titleBlock(entry: EntryView): ViewBlock {
  return entry.path === undefined
    ? { kind: "spans", spans: entry.title }
    : { kind: "file", path: entry.path };
}

function statsBlocks(entry: EntryView): readonly ViewBlock[] {
  return entry.stats.length === 0
    ? []
    : [{ kind: "spans", spans: entry.stats }];
}

function sectionBlock(entry: EntryView): ViewBlock {
  return {
    kind: "section",
    label: entry.label,
    icon: entry.icon,
    content: [titleBlock(entry), ...statsBlocks(entry)],
  };
}

/**
 * Collapses a rename to the segments that actually changed, striking the old
 * ones: `aaa/{bbb ➝ ccc}/t.txt`.
 */
function moveTitle(oldPath: string, newPath: string): readonly Span[] {
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

    return [
      { text: prefix },
      { text: "{", tone: "dim" },
      { text: oldChanged.join("/"), tone: "dim", strike: true },
      { text: ` ${ARROW} `, tone: "dim" },
      { text: newChanged.join("/"), tone: "title" },
      { text: "}", tone: "dim" },
      { text: suffix, tone: "title" },
    ];
  }

  return [
    { text: oldPath, tone: "dim", strike: true },
    { text: " " },
    { text: ARROW, tone: "dim" },
    { text: " " },
    { text: newPath, tone: "title" },
  ];
}
