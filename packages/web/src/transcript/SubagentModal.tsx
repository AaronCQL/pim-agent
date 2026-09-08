import { createEffect, createMemo, Show } from "solid-js";

import type { SessionStore } from "../session/SessionStore";
import { createScrollAnchor, observeHeight } from "../ui/scroll";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { Body } from "../view/Blocks";
import { buildRows, extendRows, type ToolRow } from "./rows";
import { Transcript } from "./Transcript";

/**
 * A subagent's run, read over the conversation that asked for it.
 *
 * The body is the transcript component the conversation itself uses, on the
 * child's own log: the prompt is the child's first user message because it
 * *is* one, its replies are assistant messages, and its calls are ordinary
 * tool rows that expand to their whole payload. Nothing here can be typed
 * into, cancelled or steered — a watch is read-only, and the header says what
 * the run did rather than offering to change it.
 *
 * The header is read off the parent's own row for the call, which is the one
 * place that knows whether the child is still working: a run opened mid-flight
 * reads as running and settles under the reader when it settles.
 */
export function SubagentModal(props: { readonly store: SessionStore }) {
  const anchor = createScrollAnchor();
  const watched = () => props.store.state.subagent;
  const durable = createMemo(() => buildRows(props.store.state.durable));

  const row = createMemo((): ToolRow | undefined => {
    const callId = watched()?.callId;
    if (callId === undefined) {
      return undefined;
    }
    // The parent's transcript answers for the call in both its states: while
    // it runs the view is in the live turn, and once it settles it is in the
    // durable result. `extendRows` is what reconciles those two, so asking it
    // is what keeps this header from being a third opinion.
    const found = extendRows(durable(), [], props.store.state.live).find(
      (candidate) => candidate.id === callId
    );
    return found?.kind === "tool" ? found : undefined;
  });

  createEffect(() => watched()?.durable.length ?? 0, anchor.stick);

  return (
    <Modal
      open={watched() !== undefined}
      label="Subagent"
      onClose={() => {
        props.store.unwatch();
      }}
      header={
        <div class="min-w-0 leading-[--line]">
          <div class="flex items-center gap-2">
            <span class="font-bold">Subagent</span>
            <Show when={row()?.isPartial}>
              <Spinner />
              <span class="text-sm text-amber-400">Running</span>
            </Show>
          </div>
          <Show when={row()?.view.summary}>
            {(summary) => (
              <div class="text-sm text-neutral-400">
                <Body blocks={summary()} />
              </div>
            )}
          </Show>
        </div>
      }
    >
      <div
        ref={anchor.mount}
        class="min-h-0 flex-1 overflow-y-auto"
        onScroll={anchor.onScroll}
      >
        <div
          // The child's rows grow after the flush that appended them, exactly
          // as the conversation's do, so the same observer holds the end.
          ref={observeHeight(anchor.stick)}
          class="mx-auto w-full max-w-3xl space-y-[--line] p-3 leading-[--line]"
        >
          <Show when={watched()}>
            {(child) => (
              <Transcript events={child().durable} live={child().live} />
            )}
          </Show>
        </div>
      </div>
    </Modal>
  );
}
