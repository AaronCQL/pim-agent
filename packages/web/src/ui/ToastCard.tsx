import type { JSX } from "@solidjs/web/jsx-runtime";

/**
 * Where a notice sits over the transcript: the same corner on a desktop, the
 * full width of a phone. Shared so the two things that toast cannot drift.
 */
export function toastAnchor(desktop: boolean): string {
  return desktop ? "right-3 max-w-sm" : "inset-x-3";
}

/** The chrome every over-the-transcript notice wears: one card, one dismiss. */
export function ToastCard(props: {
  readonly class?: string;
  readonly dismissLabel: string;
  readonly onDismiss: () => void;
  readonly children: JSX.Element;
}) {
  return (
    <div
      role="status"
      class={`rounded-lg bg-neutral-850 px-3 py-[calc(var(--line)/2)] text-sm shadow-lg ring-1 ring-neutral-700 ${props.class ?? ""}`}
    >
      <button
        type="button"
        aria-label={props.dismissLabel}
        class="float-right -mt-px ml-2 flex size-6 items-center justify-center rounded-md text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50"
        onClick={() => {
          props.onDismiss();
        }}
      >
        <span class="i-griddy-icons:close size-4" aria-hidden="true" />
      </button>
      {props.children}
    </div>
  );
}
