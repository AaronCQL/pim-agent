import type { ToolDiff } from "../DiffLines";
import { DiffView } from "../DiffView";
import { Paths } from "../Paths";
import type { Span, ToolView, ViewBlock } from "./ViewBlock";

/** View-model fragments shared by every tool that reports a file diff. */
export class DiffBlocks {
  /** `+n`/`-n` counters, empty when nothing changed. */
  public static statSpans(diff: ToolDiff | undefined): readonly Span[] {
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

  /** The counters as a title block, or nothing when there is no change. */
  public static stats(diff: ToolDiff | undefined): readonly ViewBlock[] {
    const spans = DiffBlocks.statSpans(diff);
    return spans.length === 0 ? [] : [{ kind: "spans", spans }];
  }

  public static body(diff: ToolDiff | undefined): readonly ViewBlock[] {
    return diff === undefined
      ? []
      : [{ kind: "diff", path: diff.path, hunks: diff.hunks }];
  }

  /** The whole `<path> +n/-n` row plus its diff, shared by edit and write. */
  public static fileView(args: {
    readonly label: string;
    readonly path: string | undefined;
    readonly cwd: string;
    readonly diff: ToolDiff | undefined;
  }): ToolView {
    return {
      label: args.label,
      title: [
        { kind: "file", path: Paths.titleOr(args.path, args.cwd) },
        ...DiffBlocks.stats(args.diff),
      ],
      body: DiffBlocks.body(args.diff),
      // A diff is the whole point of the row; never hide it behind an expand.
      collapsed: false,
    };
  }
}
