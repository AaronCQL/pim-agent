import type { JSX } from "@solidjs/web/jsx-runtime";
import { createSignal } from "solid-js";

import { createDialog } from "./dialog";
import { createPanZoom } from "./panZoom";
import type { Size } from "./Zoom";

const CONTROL =
  "flex items-center justify-center rounded-full bg-neutral-950/80 p-2 text-neutral-350 ring-1 ring-neutral-700 hover:text-neutral-50";

/** Content to zoom and pan over, laid out at `size`; the caller mounts it only while it is open. */
export function Lightbox(props: {
  readonly label: string;
  readonly size: Size | undefined;
  /** Moves the content on the GPU; a raster gains nothing by being redrawn, a vector blurs if it is not. */
  readonly raster?: boolean;
  readonly actions?: JSX.Element;
  readonly children: JSX.Element;
  readonly onClose: () => void;
}) {
  const dialog = createDialog({
    open: () => true,
    onClose: () => {
      props.onClose();
    },
  });
  const panZoom = createPanZoom(() => props.size);

  const contentStyle = () => {
    const size = props.size;
    const { scale, x, y } = panZoom.view();
    return size === undefined
      ? undefined
      : {
          width: `${size.width}px`,
          height: `${size.height}px`,
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
        };
  };

  return (
    <dialog
      ref={dialog.ref}
      aria-label={props.label}
      onClose={dialog.onNativeClose}
      onKeyDown={panZoom.onKeyDown}
      class="m-0 size-full max-h-none max-w-none overflow-hidden border-none bg-transparent p-0 backdrop:bg-black/80"
    >
      <div
        ref={panZoom.stageRef}
        data-stage
        class="absolute inset-0 touch-none overflow-hidden"
        onPointerDown={panZoom.onPointerDown}
        onPointerMove={panZoom.onPointerMove}
        onPointerUp={panZoom.onPointerUp}
        onPointerCancel={panZoom.onPointerCancel}
        onWheel={panZoom.onWheel}
        onClick={(event: MouseEvent) => {
          if (
            event.target === event.currentTarget &&
            panZoom.tappedBackdrop()
          ) {
            dialog.close();
          }
        }}
      >
        <div
          ref={panZoom.contentRef}
          style={contentStyle()}
          class={`absolute left-0 top-0 origin-top-left select-none ${
            props.raster ? "will-change-transform" : ""
          } ${props.size === undefined ? "invisible" : ""} ${
            panZoom.fitted()
              ? "cursor-zoom-in"
              : "cursor-grab active:cursor-grabbing"
          }`}
        >
          {props.children}
        </div>
      </div>

      <div class="absolute right-2 top-2 flex gap-1.5">
        {props.actions}
        <button
          type="button"
          aria-label="Close"
          class={CONTROL}
          onClick={() => {
            dialog.close();
          }}
        >
          <span class="i-griddy-icons:close size-4" aria-hidden="true" />
        </button>
      </div>
    </dialog>
  );
}

/** One picture, sized by its own pixels once they load, with a download beside the close. */
export function ImageLightbox(props: {
  readonly src: string;
  readonly alt: string;
  /** What a download saves it as; the address's own name when absent. */
  readonly filename?: string;
  readonly onClose: () => void;
}) {
  const [size, setSize] = createSignal<Size>();

  return (
    <Lightbox
      label={props.alt}
      size={size()}
      raster
      onClose={props.onClose}
      actions={
        <a
          href={props.src}
          download={props.filename ?? ""}
          aria-label={`Download ${props.alt}`}
          class={CONTROL}
        >
          <span class="i-griddy-icons:download size-4" aria-hidden="true" />
        </a>
      }
    >
      <img
        src={props.src}
        alt={props.alt}
        draggable="false"
        onLoad={(event: Event) => {
          const image = event.currentTarget as HTMLImageElement;
          setSize({ width: image.naturalWidth, height: image.naturalHeight });
        }}
        class="block size-full rounded-lg"
      />
    </Lightbox>
  );
}
