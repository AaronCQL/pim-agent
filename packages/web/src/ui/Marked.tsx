import { For } from "solid-js";

import type { SearchRange } from "#core/session/SearchIndex";

/**
 * The tint `::selection` wears, on the element that means it: a match is the
 * same statement a selection makes, and the UA's yellow is picked for a light
 * page.
 */
const MARK = "rounded-[2px] bg-indigo-500/35 text-inherit";

type Segment = {
  readonly text: string;
  readonly marked: boolean;
};

/**
 * Text with the server's match ranges drawn on it. The query planner expands
 * what was typed before it matches anything — a typo is corrected, a prefix
 * completed, an identifier split — so the span to mark is never something this
 * client could have found by searching the string for the query.
 */
export function Marked(props: {
  readonly text: string;
  /** Half-open character offsets into `text`; anything outside it is ignored rather than drawn. */
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

/** Every character of `text`, once and in order, whatever the ranges claim. */
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
