import { createMemo, For } from "solid-js";

import type { ToolDiffHunk } from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import { DiffLayout } from "#core/view/DiffLayout";
import type { DiffAnchors } from "../view/anchors";
import { UnifiedLines } from "../view/Blocks";
import { GapRow } from "./GapRow";

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

  // Scrolls per file so a long line can't widen the list and drag the sticky titles.
  // `--gutter` is where code text starts; comment cards indent by it.
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
              <UnifiedLines
                lines={part.hunk.lines}
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
