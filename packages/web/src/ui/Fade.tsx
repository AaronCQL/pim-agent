/**
 * The fade a pane's content runs out under, where the composer floats over its
 * foot.
 *
 * Inside the scroller rather than over it. A browser paints a scroller's own
 * scrollbars above everything that scroller contains, so a fade mounted here
 * can never cover the thumb: not the hairline a pointer gets, and not the
 * overlay bar a touch screen draws over the content with no width of its own to
 * step around. It spans the content box, which is every pixel of content and
 * nothing besides, so a full-width pane — the change set — has no edge in it to
 * see, and the gutter it stops short of is a strip no content ever reaches.
 *
 * Zero height in flow: it adds nothing to scroll height and leaves a bottom pin
 * where it was. `z-10` puts it over the content it fades, including a file's
 * sticky title bar, and counts on the scroller isolating a stacking context of
 * its own — otherwise it would also sort itself over the composer.
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
