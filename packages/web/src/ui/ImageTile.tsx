import { createSignal, Show } from "solid-js";

import { Lightbox } from "./Lightbox";

/** One picture at the size its caller allots it, opening full size when clicked. */
export function ImageTile(props: {
  readonly src: string;
  readonly alt: string;
  readonly class?: string;
  /** Intrinsic size, so the row holds its height before the bytes land. */
  readonly width?: number;
  readonly height?: number;
  readonly onError?: () => void;
}) {
  const [viewing, setViewing] = createSignal(false);

  return (
    <>
      <button
        type="button"
        aria-label={`View ${props.alt}`}
        class="block overflow-hidden rounded-lg ring-1 ring-neutral-700 hover:ring-indigo-400"
        onClick={() => {
          setViewing(true);
        }}
      >
        <img
          src={props.src}
          alt={props.alt}
          width={props.width}
          height={props.height}
          loading="lazy"
          class={`block ${props.class ?? ""}`}
          onError={props.onError}
        />
      </button>

      <Show when={viewing()}>
        <Lightbox
          src={props.src}
          alt={props.alt}
          onClose={() => {
            setViewing(false);
          }}
        />
      </Show>
    </>
  );
}
