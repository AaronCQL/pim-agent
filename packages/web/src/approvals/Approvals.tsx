import { For, Show } from "solid-js";

import type { SessionStore } from "../session/SessionStore";
import { ToolCard } from "../view/ToolCard";

/**
 * Tier 3 of the approval policy — the calls the server refuses to run
 * unattended — as a UI.
 *
 * Not a modal: a parked request can be an hour old by the time anybody looks
 * at it, and answering it needs the transcript above still readable. It is
 * also a list rather than a single prompt, because the router parks per call
 * and a client that attaches late can inherit several at once.
 *
 * Nothing here knows what any tool does. The tier came from the tool's own
 * `effect` declaration on the server; this paints the `ToolView` it was handed
 * and sends `approve_tool` back.
 */
export function Approvals(props: { readonly store: SessionStore }) {
  return (
    <Show when={props.store.state.approvals.length > 0}>
      <section
        aria-label="Tool approvals"
        class="flex flex-col gap-2 rounded-lg border border-amber-800/70 bg-amber-950/20 p-2"
      >
        <For each={props.store.state.approvals}>
          {(request) => (
            <article class="flex flex-col gap-1">
              <ToolCard view={request.view} isPartial />
              <p class="text-xs text-amber-300">{request.reason}</p>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="rounded bg-emerald-900/70 px-3 py-1 text-sm text-emerald-100 hover:bg-emerald-800"
                  onClick={() => {
                    void props.store.approve(request.callId, true);
                  }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  class="rounded bg-red-900/70 px-3 py-1 text-sm text-red-100 hover:bg-red-800"
                  onClick={() => {
                    void props.store.approve(request.callId, false);
                  }}
                >
                  Deny
                </button>
              </div>
            </article>
          )}
        </For>
      </section>
    </Show>
  );
}
