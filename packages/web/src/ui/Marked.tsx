import { For } from "solid-js";

import type { SearchRange } from "#core/session/SearchIndex";

const MARK = "rounded-[2px] bg-indigo-500/25 text-indigo-300";

type Segment = {
  readonly text: string;
  readonly marked: boolean;
};

/** Highlights the server's match ranges; the server expands the query, so the client cannot find them itself. */
export function Marked(props: {
  readonly text: string;
  /** Half-open offsets into `text`; out-of-range parts are clamped. */
  readonly ranges: readonly SearchRange[];
}) {
  return (
    <For each={segmentsOf(props.text, props.ranges)}>
      {(segment) =>
        segment.marked ? <mark class={MARK}>{segment.text}</mark> : segment.text
      }
    </For>
  );
}

/** Covers `text` exactly once, even for overlapping or out-of-range ranges. */
function segmentsOf(
  text: string,
  ranges: readonly SearchRange[]
): readonly Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    const from = Math.min(Math.max(start, at), text.length);
    const to = Math.min(Math.max(end, from), text.length);
    if (to === from) {
      continue;
    }
    if (from > at) {
      segments.push({ text: text.slice(at, from), marked: false });
    }
    segments.push({ text: text.slice(from, to), marked: true });
    at = to;
  }
  if (at < text.length) {
    segments.push({ text: text.slice(at), marked: false });
  }
  return segments;
}
