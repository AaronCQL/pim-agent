import { createMemo, createSignal, onCleanup, Show } from "solid-js";

import { JobLine } from "#core/extensions/subagent/JobLine";
import { Format } from "#core/shared/Format";

import type { SessionStore } from "../session/SessionStore";
import { Modal } from "../ui/Modal";
import { createBottomPin } from "../ui/scroll";
import { Spinner } from "../ui/Spinner";
import { Body, SpanText } from "../view/Blocks";
import { buildRows, extendRows, type ToolRow } from "./rows";
import { Transcript } from "./Transcript";

export function SubagentModal(props: { readonly store: SessionStore }) {
  const watched = () => props.store.state.subagent;
  const durable = createMemo(() => buildRows(props.store.state.durable));
  const pin = createBottomPin();
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => {
    setNow(Date.now());
  }, 1000);
  onCleanup(() => {
    clearInterval(clock);
  });

  const row = createMemo((): ToolRow | undefined => {
    const callId = watched()?.callId;
    if (callId === undefined) {
      return undefined;
    }
    return extendRows(durable(), [], props.store.state.live).findLast(
      (candidate): candidate is ToolRow =>
        candidate.kind === "tool" && candidate.child === callId
    );
  });
  const job = createMemo(() =>
    props.store.state.jobs.find((one) => one.id === watched()?.callId)
  );
  const running = createMemo(
    () => row()?.isPartial === true || job() !== undefined
  );

  return (
    <Modal
      open={watched() !== undefined}
      label="Subagent"
      onClose={() => {
        props.store.unwatch();
      }}
      header={
        <div class="flex min-w-0 items-center gap-2 text-sm leading-[--line]">
          <Show
            when={running()}
            fallback={
              <span
                role="img"
                aria-label={
                  row()?.state ?? (row()?.isError ? "failed" : "done")
                }
                class={{
                  "size-3 shrink-0": true,
                  "i-lucide-check text-emerald-400": !row()?.isError,
                  "i-lucide-circle-alert text-rose-400":
                    row()?.isError === true,
                }}
              />
            }
          >
            <span class="inline-flex" role="img" aria-label="Running">
              <Spinner />
            </span>
          </Show>
          <Show
            when={job()}
            fallback={
              <div class="min-w-0 flex-1 truncate text-neutral-400">
                <Show when={row()?.view.title} fallback="Subagent">
                  {(title) => <Body blocks={title()} />}
                </Show>
              </div>
            }
          >
            {(active) => (
              <>
                <span class="shrink-0 font-bold">{active().handle}</span>
                <span class="min-w-0 flex-1 truncate text-neutral-400">
                  <Show when={JobLine.context(active())[0]}>
                    {(context) => <SpanText span={context()} />}
                  </Show>
                </span>
                <span class="shrink-0 tabular-nums text-neutral-400">
                  {Format.formatElapsed(now() - active().startedAt)}
                </span>
              </>
            )}
          </Show>
        </div>
      }
    >
      <div
        ref={pin.ref}
        class={{
          "flex min-h-0 flex-1 flex-col-reverse overflow-y-auto": true,
          "[overflow-anchor:none]": pin.pinned(),
        }}
      >
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
