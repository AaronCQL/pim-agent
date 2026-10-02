/**
 * Bottom fade under the floating composer. Mount it inside the scroller so it
 * never covers the scrollbar. Zero height, so scroll height is unchanged; the
 * scroller must isolate a stacking context or `z-10` lifts it over the composer.
 */
export function Fade(props: { readonly height: number }) {
  return (
    <div class="pointer-events-none sticky bottom-0 z-10 h-0 flex-none">
      <div
        class="absolute inset-x-0 bottom-0 bg-linear-to-t from-neutral-925 to-neutral-925/0 from-75% to-100%"
        style={{ height: `${props.height}px` }}
      />
    </div>
  );
}
