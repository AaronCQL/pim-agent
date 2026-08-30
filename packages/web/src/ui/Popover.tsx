import { createEffect, createSignal, type Element } from "solid-js";

/**
 * The only wrapper feature code may use for an overlay that is not modal.
 *
 * The platform primitive is the `popover` attribute: it promotes the element
 * to the top layer, so a picker anchored to an input is never clipped by an
 * ancestor's `overflow`, and it brings light-dismiss and ESC with it. That is
 * the whole reason no headless component library is installed (Guiding
 * Decision 13) — this used to be Floating UI's job.
 *
 * `manual` rather than `auto` because the picker's lifetime is owned by the
 * composer's token state: a light-dismiss that closed it behind the composer's
 * back would leave the two disagreeing. Dismissal is routed through
 * `onDismiss` instead.
 *
 * Engines without the attribute (and happy-dom, which is why the tests can see
 * this path) fall back to ordinary absolute positioning; nothing above here
 * has to know which one it got.
 */
export function Popover(props: {
  readonly open: boolean;
  /** A CSS `anchor-name` the trigger declares, e.g. `--pim-composer`. */
  readonly anchor?: string;
  readonly class?: string;
  readonly children: Element;
}) {
  const [native, setNative] = createSignal(false);
  let host!: HTMLDivElement;

  createEffect(
    () => ({ open: props.open, native: native() }),
    ({ open, native: isNative }) => {
      if (!isNative) {
        return;
      }
      try {
        if (open) {
          host.showPopover();
        } else {
          host.hidePopover();
        }
      } catch {
        // Toggling to the state it is already in throws; nothing to do.
      }
    }
  );

  return (
    <div
      ref={(element: HTMLDivElement) => {
        host = element;
        setNative(typeof element.showPopover === "function");
      }}
      popover="manual"
      class={{
        [props.class ?? ""]: props.class !== undefined,
        hidden: !props.open,
      }}
      style={
        props.anchor === undefined
          ? { position: "absolute" }
          : {
              "position-anchor": props.anchor,
              position: "absolute",
              "inset-area": "block-start span-inline-end",
              bottom: `anchor(${props.anchor} top)`,
              left: `anchor(${props.anchor} left)`,
              "min-width": `anchor-size(${props.anchor} width)`,
              margin: "0 0 0.25rem 0",
            }
      }
    >
      {props.children}
    </div>
  );
}
