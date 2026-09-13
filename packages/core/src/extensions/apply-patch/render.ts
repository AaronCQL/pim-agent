import type { ToolDiff } from "../../shared/DiffLines";
import { Paths } from "../../shared/Paths";
import { PatchSummary } from "../../shared/PatchSummary";
import type { ToolViewInput } from "../../shared/Tools";
import { DiffBlocks } from "../../view/DiffBlocks";
import { MovePath } from "../../view/MovePath";
import type { Span, ToolIcon, ToolView, ViewBlock } from "../../view/ViewBlock";
import type { ApplyEntry } from "./executor";
import { type applyPatchSchema, prepareApplyPatchArguments } from "./schema";

const ARROW = MovePath.ARROW;

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
  readonly path: string | undefined;
  readonly stats: readonly Span[];
  readonly body: ToolDiff | undefined;
};

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

function visibleEntries(
  details: ApplyPatchDetails | undefined
): readonly ApplyEntry[] {
  return (details?.entries ?? []).filter(
    (entry) => !(entry.action.kind === "update" && entry.diff === undefined)
  );
}

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
      return {
        label: "Write",
        icon: "edit",
        ...plain(entry.action.path),
        stats,
        body: entry.diff,
      };
    case "delete":
      return {
        label: "Delete",
        icon: "trash",
        ...plain(entry.action.path),
        stats,
        body: undefined,
      };
    case "move":
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

function moveTitle(oldPath: string, newPath: string): readonly Span[] {
  const folded = MovePath.fold(oldPath, newPath);

  if (folded === undefined) {
    return [
      { text: oldPath, tone: "dim", strike: true },
      { text: " " },
      { text: ARROW, tone: "dim" },
      { text: " " },
      { text: newPath, tone: "title" },
    ];
  }

  return [
    { text: folded.prefix },
    { text: "{", tone: "dim" },
    { text: folded.from, tone: "dim", strike: true },
    { text: ` ${ARROW} `, tone: "dim" },
    { text: folded.to, tone: "title" },
    { text: "}", tone: "dim" },
    { text: folded.suffix, tone: "title" },
  ];
}
