import { createMemo, For } from "solid-js";

import type { ToolDiffHunk } from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import { DiffLayout } from "#core/view/DiffLayout";
import { UnifiedHunk } from "../view/Blocks";
import { GapRow } from "./GapRow";

/** One column of both sides, the layout a narrow screen gets, with its gaps open to a reader. */
export function UnifiedDiff(props: {
  readonly path: string;
  readonly hunks: readonly ToolDiffHunk[];
  readonly total: number | undefined;
  readonly busy: boolean;
  readonly onOpen: (gap: DiffGap) => void;
}) {
  const lang = createMemo(() => Languages.fromPath(props.path));
  const width = createMemo(() => DiffLayout.gutterWidth(props.hunks));
  const parts = createMemo(() => DiffExpand.parts(props.hunks, props.total));

  return (
    <div class="w-max min-w-full leading-[--line] text-neutral-300 [tab-size:3]">
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
            <UnifiedHunk hunk={part.hunk} lang={lang()} width={width()} />
          )
        }
      </For>
    </div>
  );
}
