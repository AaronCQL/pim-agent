import { Show } from "solid-js";

import { ToastCard, toastAnchor } from "../ui/ToastCard";
import type { Reload, ReloadNotice } from "./Reload";

const TONE_CLASSES = {
  success: "",
  warning: "text-amber-400",
  error: "text-rose-400",
} as const satisfies Record<ReloadNotice["tone"], string>;

/** What the app has to say about itself, over the transcript rather than in it. */
export function Toast(props: {
  readonly update: Reload;
  readonly desktop: boolean;
}) {
  const state = () => props.update.state;
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
      <ToastCard
        class={`absolute top-3 z-50 ${toastAnchor(props.desktop)} ${tone()}`}
        dismissLabel="Dismiss notification"
        onDismiss={() => props.update.dismiss()}
      >
        <span class="whitespace-pre-wrap">
          {state().pending ? state().label : state().notice?.text}
        </span>
      </ToastCard>
    </Show>
  );
}
