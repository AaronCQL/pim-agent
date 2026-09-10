import { createMemo, Show } from "solid-js";

import type { SessionStore } from "../session/SessionStore";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { Body } from "../view/Blocks";
import { buildRows, extendRows, type ToolRow } from "./rows";
import { Transcript } from "./Transcript";

/** A subagent's run, read-only, over the conversation that asked for it. */
export function SubagentModal(props: { readonly store: SessionStore }) {
  const watched = () => props.store.state.subagent;
  const durable = createMemo(() => buildRows(props.store.state.durable));

  const row = createMemo((): ToolRow | undefined => {
    const callId = watched()?.callId;
    if (callId === undefined) {
      return undefined;
    }
    // `extendRows` reconciles the live and settled views of the call, so this
    // header is not a third opinion.
    const found = extendRows(durable(), [], props.store.state.live).find(
      (candidate) => candidate.id === callId
    );
    return found?.kind === "tool" ? found : undefined;
  });

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
      <div class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <div class="mx-auto min-h-full w-full max-w-3xl flex-none space-y-[--line] p-3 leading-[--line]">
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
