import { Show } from "solid-js";

import type { Reload } from "./Reload";

/**
 * What the app has to say about itself, over the transcript rather than in
 * it: an update is downloading, a restart landed, this tab is talking to a
 * server that has moved on.
 *
 * It is a panel that happens to be small, so it is drawn the way every other
 * panel over the session is drawn — the modal's hairline, corner and close
 * button — but a step lighter than the page it covers, because a card the
 * same colour as the transcript behind it is a card only its shadow can find.
 * Tone colours only the two states worth interrupting for. Success stays the
 * page's own ink: a sentence reporting the thing the reader just asked for
 * does not also need to be green about it.
 *
 * The caller mounts it **inside the transcript column**, below the topbar and
 * beside the sidebar, so "under the nav" is where the DOM puts it rather than
 * a top offset that has to be re-measured every time the topbar changes
 * height.
 *
 * One shape at both sizes: a pill inset from the top corner. All that changes
 * is what stops it growing — a desktop caps it at `max-w-sm` and hangs it off
 * the right edge, clear of the scrollbar, while a phone lets it run to the
 * far margin, since a pill kept narrow on a narrow screen is a column of
 * three-word lines beside a stripe of empty transcript.
 */
export function Toast(props: {
  readonly update: Reload;
  readonly desktop: boolean;
}) {
  const state = () => props.update.state;
  return (
    <Show
      when={
        !state().dismissed && (state().pending || state().notice !== undefined)
      }
    >
      <div
        role="status"
        class={{
          // Half a `--line` of air above and below, the rhythm the modal
          // header keeps. No height anywhere: a two-line notice is two lines
          // tall and a one-liner is one line tall, close button included.
          "absolute top-3 z-50 rounded-lg bg-neutral-850 px-3 py-[calc(var(--line)/2)] text-sm shadow-lg ring-1 ring-neutral-700": true,
          "right-3 max-w-sm": props.desktop,
          "inset-x-3": !props.desktop,
          "text-amber-400": state().notice?.tone === "warning",
          "text-rose-400": state().notice?.tone === "error",
        }}
      >
        {/* Floated, not a flex item, and first in source because that is what
            a float needs: the message wraps around it on the line it shares
            and reclaims the full width underneath, instead of every line
            paying for a button that only ever occupies the first one. A
            float also adds no height of its own, so the toast is as tall as
            what it says.

            The modal's close button scaled down: same icon, same square with
            no fill until it is pointed at, at 24px rather than 32px — a
            control that has to sit on one line of text without setting that
            line's height cannot also be the tallest thing in the box. The
            hover fill is a step lighter than the modal's, to land above this
            panel rather than disappear into it.

            Offered while an update is still running too. Whoever does not
            care how the download is going should not have to wait for it to
            land to get their corner back, and the update carries on either
            way: what it has to report comes back as the next toast. */}
        <button
          type="button"
          aria-label="Dismiss notification"
          class="float-right -mt-px ml-2 flex size-6 items-center justify-center rounded-md text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50"
          onClick={() => props.update.dismiss()}
        >
          <span class="i-griddy-icons:close size-4" aria-hidden="true" />
        </button>
        <span class="whitespace-pre-wrap">
          {state().pending ? state().label : state().notice?.text}
        </span>
        {/* The only notice that names something to do here rather than
            somewhere else: a tab the server has moved on from is repaired by
            fetching this page again, and the reader is already looking at the
            sentence that says so — so it reads as the next word of it, not as
            a toolbar under it. */}
        <Show when={state().notice?.action === "reload"}>
          <button
            type="button"
            class="ml-1ch inline-flex h-6 items-center rounded-md bg-neutral-800 px-2 align-text-bottom text-neutral-100 hover:bg-neutral-700"
            onClick={() => props.update.refresh()}
          >
            Reload
          </button>
        </Show>
      </div>
    </Show>
  );
}
