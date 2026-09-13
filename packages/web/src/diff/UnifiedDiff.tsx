import { createMemo, For } from "solid-js";

import type { ToolDiffHunk } from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import { DiffLayout } from "#core/view/DiffLayout";
import type { DiffAnchors } from "../view/anchors";
import { UnifiedHunk } from "../view/Blocks";
import { GapRow } from "./GapRow";

/** One column of both sides, the layout a narrow screen gets, with its gaps open to a reader. */
export function UnifiedDiff(props: {
  readonly path: string;
  readonly hunks: readonly ToolDiffHunk[];
  readonly total: number | undefined;
  readonly busy: boolean;
  readonly onOpen: (gap: DiffGap) => void;
  readonly anchors?: DiffAnchors;
}) {
  const lang = createMemo(() => Languages.fromPath(props.path));
  const width = createMemo(() => DiffLayout.gutterWidth(props.hunks));
  const parts = createMemo(() => DiffExpand.parts(props.hunks, props.total));

  // A line is never re-wrapped, so a long one is panned to — inside this file
  // and nowhere else. The scroller is the file's own: without it the only
  // scroller on the page is the list of files, and one long line there widens
  // the list, which pans every file's sticky title bar off the left edge with
  // it. `overscroll-x-contain` keeps a pan that reaches the end of a line from
  // becoming the browser's back gesture.
  //
  // `--gutter` is where the code text starts, which is what a comment card
  // hanging off a row indents itself by: it varies with this file's numbering.
  return (
    <div class="overflow-x-auto overscroll-x-contain">
      <div
        class="w-max min-w-full leading-[--line] text-neutral-300 [tab-size:3]"
        style={{ "--gutter": `${width() + 4}ch` }}
      >
        <For each={parts()}>
          {(part) =>
            "gap" in part ? (
              <GapRow
                gap={part.gap}
                width={width()}
                split={false}
                busy={props.busy}
                onOpen={props.onOpen}
              />
            ) : (
              <UnifiedHunk
                hunk={part.hunk}
                lang={lang()}
                width={width()}
                anchors={props.anchors}
              />
            )
          }
        </For>
      </div>
    </div>
  );
}
