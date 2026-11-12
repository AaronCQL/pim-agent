import type { JSX } from "@solidjs/web/jsx-runtime";
import { onCleanup, untrack } from "solid-js";

export function toastAnchor(desktop: boolean): string {
  return desktop ? "right-3 max-w-sm" : "inset-x-3 mx-auto items-center";
}

export function ToastCard(props: {
  readonly class?: string;
  readonly dismissLabel: string;
  readonly onDismiss: () => void;
  readonly dismissMs?: number;
  readonly children: JSX.Element;
}) {
  let card!: HTMLDivElement;
  let hovered = false;
  let focused = false;
  let remaining = untrack(() => props.dismissMs);
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pause = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, remaining! - (performance.now() - started));
    }
  };
  const resume = (): void => {
    if (timer !== undefined || remaining === undefined || hovered || focused) {
      return;
    }
    started = performance.now();
    timer = setTimeout(props.onDismiss, remaining);
  };

  untrack(resume);
  onCleanup(() => {
    clearTimeout(timer);
  });

  return (
    <div
      ref={(element) => {
        card = element;
      }}
      role="status"
      class={`pointer-events-auto relative flex w-fit max-w-full rounded-lg bg-neutral-850 py-2 pl-3 pr-10 text-sm shadow-lg ring-1 ring-neutral-700 ${props.class ?? ""}`}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") {
          return;
        }
        hovered = true;
        pause();
      }}
      onPointerLeave={() => {
        hovered = false;
        resume();
      }}
      onFocusIn={() => {
        focused = true;
        pause();
      }}
      onFocusOut={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          card.contains(event.relatedTarget)
        ) {
          return;
        }
        focused = false;
        resume();
      }}
    >
      <div class="min-w-0 break-words">{props.children}</div>
      <button
        type="button"
        aria-label={props.dismissLabel}
        class="absolute right-0.5 top-0.5 flex size-8 items-center justify-center rounded-md text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-350"
        onClick={() => props.onDismiss()}
      >
        <span class="i-griddy-icons:close size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
