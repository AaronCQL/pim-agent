import { createSignal, Show } from "solid-js";

const FLASH_MS = 1200;

/**
 * Copy-to-clipboard, wrapped for the same reason the overlays are: the async
 * clipboard API needs a permission-denied path and a fallback, and feature
 * code should express "copy this" and nothing more.
 *
 * Always visible, per the mockup — a hover-only affordance does not exist on a
 * phone, and this one sits over code that is worth copying from either.
 */
export function CopyButton(props: {
  readonly text: () => string;
  readonly label?: string;
  readonly class?: string;
}) {
  const [copied, setCopied] = createSignal(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.text());
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, FLASH_MS);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      title={props.label ?? "Copy"}
      aria-label={props.label ?? "Copy"}
      class={`flex size-7 shrink-0 items-center justify-center rounded-lg bg-neutral-850 text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50 ${props.class ?? ""}`}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        void copy();
      }}
    >
      <Show
        when={copied()}
        fallback={
          <span class="i-griddy-icons:copy size-4" aria-hidden="true" />
        }
      >
        <span class="i-griddy-icons:check size-4 text-emerald-400" />
      </Show>
    </button>
  );
}
