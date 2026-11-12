import { Show } from "solid-js";

import { ToastCard, toastAnchor } from "../ui/ToastCard";
import type { Reload, ReloadNotice } from "./Reload";

const TONE_CLASSES = {
  success: "",
  warning: "text-amber-400",
  error: "text-rose-400",
} as const satisfies Record<ReloadNotice["tone"], string>;

/** Reload and version notices. */
export function Toast(props: {
  readonly update: Reload;
  readonly desktop: boolean;
}) {
  const state = () => props.update.state;
  const detail = (): string | undefined =>
    state().pending ? state().detail : state().notice?.text;
  const tone = (): string => {
    const notice = state().notice;
    return notice === undefined ? "" : TONE_CLASSES[notice.tone];
  };
  return (
    <Show
      when={
        !state().dismissed && (state().pending || state().notice !== undefined)
      }
    >
      <div
        class={`pointer-events-none absolute top-3 z-50 flex flex-col ${toastAnchor(props.desktop)}`}
      >
        <ToastCard
          class={tone()}
          dismissLabel="Dismiss notification"
          onDismiss={() => props.update.dismiss()}
        >
          <div>{state().pending ? state().label : state().notice?.title}</div>
          <Show when={detail()}>
            <div class="mt-1 whitespace-pre-wrap text-xs text-neutral-350">
              {detail()}
            </div>
          </Show>
        </ToastCard>
      </div>
    </Show>
  );
}
