/**
 * The mark for "a turn is running", wherever one is being reported.
 *
 * Hand-rolled rather than an icon: the pack has no loader glyph, and a ring
 * with one quadrant knocked out is the three-quarter arc every spinner is.
 * The lit sides are per-side colours, not `border-indigo-400`: that shorthand
 * is emitted twice, once as an srgb fallback and once inside a trailing
 * `@supports color-mix(in lab)` block, and the second copy lands after
 * `border-t-transparent` and paints the gap back in. The spin is unguarded by
 * `motion-reduce`: a frozen arc reads as a hung turn, and a 12px mark is not
 * the moving content that rule is for.
 */
export function Spinner() {
  return (
    <span
      class="size-3 shrink-0 animate-spin rounded-full border-1.5 border-x-indigo-400 border-b-indigo-400 border-t-transparent"
      aria-hidden="true"
    />
  );
}
