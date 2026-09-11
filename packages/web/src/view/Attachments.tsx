import { createSignal, For, Show } from "solid-js";

import type { AttachmentView } from "#protocol/ServerEvent";
import { Lightbox } from "../ui/Lightbox";
import { Spinner } from "../ui/Spinner";

/** One file as a row draws it, plus what only an unsent one has. */
export type AttachmentTile = AttachmentView & {
  readonly key: string;
  readonly uploading?: boolean;
  readonly onRemove?: () => void;
};

/** How much room a tile gets: `grid` and `compact` are inputs, `delivery` is output. */
export type TileVariant = "grid" | "compact" | "delivery";

const IMAGE_CLASSES: Record<TileVariant, string> = {
  grid: "size-32 object-cover sm:size-40",
  compact: "size-16 object-cover",
  delivery: "max-h-80 max-w-full object-contain",
};

/** The files on a message: pictures shown as pictures, everything else as a chip. */
export function Attachments(props: {
  readonly files: readonly AttachmentTile[];
  readonly variant?: TileVariant;
}) {
  return (
    <Show when={props.files.length > 0}>
      <ul class="flex flex-wrap gap-2">
        {/* Keyed: a tile keeps its own state when the row is rebuilt around it. */}
        <For each={props.files} keyed={(file: AttachmentTile) => file.key}>
          {(file) => <Tile file={file()} variant={props.variant ?? "grid"} />}
        </For>
      </ul>
    </Show>
  );
}

function Tile(props: {
  readonly file: AttachmentTile;
  readonly variant: TileVariant;
}) {
  const [viewing, setViewing] = createSignal(false);
  // A file stored by another frontend 404s here, so the chip is the fallback.
  const [broken, setBroken] = createSignal(false);
  const shows = () => props.file.isImage && !broken();

  return (
    <li class="relative">
      <Show when={shows()} fallback={<Chip file={props.file} />}>
        <button
          type="button"
          aria-label={`View ${props.file.name}`}
          class="block overflow-hidden rounded-lg ring-1 ring-neutral-700 hover:ring-indigo-400"
          onClick={() => {
            setViewing(true);
          }}
        >
          <img
            src={props.file.url}
            alt={props.file.name}
            loading="lazy"
            class={`block ${IMAGE_CLASSES[props.variant]} ${
              props.file.uploading ? "opacity-50" : ""
            }`}
            onError={() => {
              setBroken(true);
            }}
          />
        </button>
      </Show>

      <Show when={props.variant === "delivery" && shows()}>
        <a
          href={props.file.url}
          download={props.file.name}
          aria-label={`Download ${props.file.name}`}
          class="absolute right-1.5 top-1.5 flex items-center justify-center rounded-full bg-neutral-950/80 p-1.5 text-neutral-350 ring-1 ring-neutral-700 hover:text-neutral-50"
        >
          <span class="i-griddy-icons:download size-4" aria-hidden="true" />
        </a>
      </Show>

      <Show when={props.file.uploading}>
        <span class="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      </Show>

      <Show when={props.file.onRemove}>
        {(remove) => (
          <button
            type="button"
            aria-label={`Remove ${props.file.name}`}
            class="absolute -right-1.5 -top-1.5 flex items-center justify-center rounded-full bg-neutral-950 p-0.5 text-neutral-350 ring-1 ring-neutral-700 hover:text-neutral-50"
            onClick={() => remove()()}
          >
            <span class="i-griddy-icons:close size-3.5" aria-hidden="true" />
          </button>
        )}
      </Show>

      <Show when={viewing()}>
        <Lightbox
          src={props.file.url}
          alt={props.file.name}
          onClose={() => {
            setViewing(false);
          }}
        />
      </Show>
    </li>
  );
}

function Chip(props: { readonly file: AttachmentTile }) {
  return (
    <a
      href={props.file.url}
      download={props.file.name}
      target="_blank"
      rel="noreferrer"
      class="flex items-center gap-1.5 rounded-full bg-neutral-900 px-2.5 py-1 text-sm text-neutral-350 ring-1 ring-neutral-750 hover:text-neutral-50"
    >
      <span
        class="i-griddy-icons:download size-4 shrink-0"
        aria-hidden="true"
      />
      <span class="max-w-40 truncate">{props.file.name}</span>
    </a>
  );
}
