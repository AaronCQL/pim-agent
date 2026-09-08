/** The mark for "a turn is running"; keep the lit sides per-side, as `border-indigo-400` is emitted twice and paints the gap back in. */
export function Spinner() {
  return (
    <span
      class="size-3 shrink-0 animate-spin rounded-full border-1.5 border-x-indigo-400 border-b-indigo-400 border-t-transparent"
      aria-hidden="true"
    />
  );
}
