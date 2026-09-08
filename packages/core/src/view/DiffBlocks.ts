import type { ToolDiff } from "../shared/DiffLines";
import { DiffView } from "../shared/DiffView";
import { Paths } from "../shared/Paths";
import type { Span, ToolView, ViewBlock } from "./ViewBlock";

function statSpans(diff: ToolDiff | undefined): readonly Span[] {
  const { added, removed } = DiffView.countStats(diff);
  const spans: Span[] = [];

  if (added > 0) {
    spans.push({ text: `+${added}`, tone: "added" });
  }
  if (removed > 0) {
    if (spans.length > 0) {
      spans.push({ text: "/" });
    }
    spans.push({ text: `-${removed}`, tone: "removed" });
  }

  return spans;
}

function stats(diff: ToolDiff | undefined): readonly ViewBlock[] {
  const spans = statSpans(diff);
  return spans.length === 0 ? [] : [{ kind: "spans", spans }];
}

function body(diff: ToolDiff | undefined): readonly ViewBlock[] {
  return diff === undefined
    ? []
    : [{ kind: "diff", path: diff.path, hunks: diff.hunks }];
}

function fileView(args: {
  readonly label: string;
  readonly path: string | undefined;
  readonly cwd: string;
  readonly diff: ToolDiff | undefined;
}): ToolView {
  return {
    label: args.label,
    icon: "edit",
    title: [
      { kind: "file", path: Paths.titleOr(args.path, args.cwd) },
      ...stats(args.diff),
    ],
    body: body(args.diff),
  };
}

/** View-model fragments shared by every tool that reports a file diff. */
export const DiffBlocks = { statSpans, stats, body, fileView };
