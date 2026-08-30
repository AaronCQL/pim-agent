import { createSignal, Show } from "solid-js";

const FLASH_MS = 1200;

/**
 * Copy-to-clipboard, wrapped for the same reason the overlays are: the async
 * clipboard API needs a permission-denied path and a fallback, and feature
 * code should express "copy this" and nothing more.
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
      class={`shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 ${props.class ?? ""}`}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        void copy();
      }}
    >
      <Show
        when={copied()}
        fallback={<span class="i-lucide-copy block" aria-hidden="true" />}
      >
        <span
          class="i-lucide-check block text-emerald-400"
          aria-hidden="true"
        />
      </Show>
    </button>
  );
}
