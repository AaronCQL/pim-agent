import { createSignal, For, Show } from "solid-js";

import type { AttachmentView } from "#protocol/ServerEvent";
import { Lightbox } from "../ui/Lightbox";
import { Spinner } from "../ui/Spinner";

/** One file as a row draws it, plus what only an unsent one has. */
export type AttachmentTile = AttachmentView & {
  /** Stable across the swap from a local preview to the stored bytes. */
  readonly key: string;
  /** The upload is still in flight, so `url` is this browser's own copy. */
  readonly uploading?: boolean;
  readonly onRemove?: () => void;
};

/**
 * The files on a message, in the two shapes a file comes in: a picture, shown
 * as one, and everything else as a chip that downloads.
 *
 * A thumbnail is the full image scaled by the browser rather than a rendition
 * the server made. Every one of these came off the machine the agent runs on
 * moments ago and is served with an immutable cache header, so the second
 * look costs nothing — and a resizing pipeline is a lot of server to save one
 * screenshot's worth of bytes on a local network.
 */
export function Attachments(props: {
  readonly files: readonly AttachmentTile[];
  /** The composer's row, which sits above a textarea and must stay small. */
  readonly compact?: boolean;
}) {
  return (
    <Show when={props.files.length > 0}>
      <ul class="flex flex-wrap gap-2">
        {/* Keyed, so a tile keeps its own state — what it is showing, and
            whether the picture failed to load — while the row around it is
            rebuilt by an upload finishing beside it. */}
        <For each={props.files} keyed={(file: AttachmentTile) => file.key}>
          {(file) => <Tile file={file()} compact={props.compact === true} />}
        </For>
      </ul>
    </Show>
  );
}

function Tile(props: {
  readonly file: AttachmentTile;
  readonly compact: boolean;
}) {
  const [viewing, setViewing] = createSignal(false);
  // A file stored by another frontend lives under a root this server does not
  // publish, so its bytes are a 404 and the picture would be a broken glyph
  // in the middle of the conversation. The chip is the honest fallback: the
  // name is still worth reading.
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
            class={`block object-cover ${
              props.compact ? "size-16" : "size-32 sm:size-40"
            } ${props.file.uploading ? "opacity-50" : ""}`}
            onError={() => {
              setBroken(true);
            }}
          />
        </button>
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
            // Over the corner of the tile rather than beside it: the row is
            // as tall as its tiles either way, and a control on the outside
            // would reflow the composer every time a file was added.
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

/**
 * Anything that is not a picture. A link rather than a button: the bytes are
 * on the server and the browser already knows how to save a file, so the
 * whole behaviour is an `href` — and it is the same URL the thumbnail would
 * have used.
 */
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
        class="i-griddy-icons:attachment size-4 shrink-0"
        aria-hidden="true"
      />
      <span class="max-w-40 truncate">{props.file.name}</span>
    </a>
  );
}
