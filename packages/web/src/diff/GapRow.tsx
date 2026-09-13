import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import { DIFF_GAP_CLASS } from "../view/tokens";

function unchanged(gap: DiffGap): string {
  return `${gap.count.toLocaleString()} ${gap.count === 1 ? "line" : "lines"} unchanged`;
}

/**
 * The lines between two hunks, offered rather than merely marked: clicking
 * reads the file's own text around the gap and puts it on the page, a step at
 * a time until nothing of the gap is left.
 */
export function GapRow(props: {
  readonly gap: DiffGap;
  readonly width: number;
  readonly split: boolean;
  readonly busy: boolean;
  readonly onOpen: (gap: DiffGap) => void;
}) {
  return (
    <button
      type="button"
      disabled={props.busy}
      aria-label={`Show ${DiffExpand.revealed(props.gap)} more lines`}
      class={`items-center text-left text-neutral-500 ${DIFF_GAP_CLASS} ${
        props.busy ? "" : "hover:bg-neutral-500/15"
      } ${props.split ? "col-span-full grid grid-cols-subgrid" : "flex w-full"}`}
      onClick={() => {
        props.onOpen(props.gap);
      }}
    >
      <span class="flex shrink-0 items-center">
        <span style={{ width: `${props.width + 2}ch` }} />
        <span class="flex w-1ch justify-center">
          <span
            class="i-griddy-icons:unfold-more size-4 shrink-0"
            aria-hidden="true"
          />
        </span>
      </span>
      <span class="truncate pl-1ch">{unchanged(props.gap)}</span>
    </button>
  );
}
