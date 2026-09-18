import { For, onCleanup, untrack } from "solid-js";

import { ToastCard, toastAnchor } from "../ui/ToastCard";
import { NOTICE_CLASSES } from "../view/tokens";
import type { UiNotice } from "./SessionStore";

const DISMISS_MS = 10_000;

function Notice(props: {
  readonly notice: UiNotice;
  readonly dismissMs: number;
  readonly onDismiss: (id: string) => void;
}) {
  const dismiss = (): void => {
    props.onDismiss(props.notice.id);
  };
  // A snapshot: how long this one lives is settled when it arrives.
  const timer = setTimeout(
    dismiss,
    untrack(() => props.dismissMs)
  );
  onCleanup(() => {
    clearTimeout(timer);
  });

  return (
    <ToastCard
      class={`pointer-events-auto w-full ${NOTICE_CLASSES[props.notice.severity]}`}
      dismissLabel="Dismiss notice"
      onDismiss={dismiss}
    >
      <span class="line-clamp-3 break-words whitespace-pre-wrap">
        {props.notice.text}
      </span>
    </ToastCard>
  );
}

/** What an extension said with nobody waiting on it: over the transcript, never in front of it. */
export function NoticeToast(props: {
  readonly notices: readonly UiNotice[];
  readonly desktop: boolean;
  readonly onDismiss: (id: string) => void;
  readonly dismissMs?: number;
}) {
  return (
    <div
      class={`pointer-events-none absolute top-3 z-40 flex flex-col gap-2 ${toastAnchor(props.desktop)}`}
    >
      <For each={props.notices}>
        {(notice) => (
          <Notice
            notice={notice}
            dismissMs={props.dismissMs ?? DISMISS_MS}
            onDismiss={props.onDismiss}
          />
        )}
      </For>
    </div>
  );
}
