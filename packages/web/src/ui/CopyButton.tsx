import { createSignal, onCleanup, Show } from "solid-js";

import { copyText } from "./clipboard";

const FLASH_MS = 1200;

export function CopyButton(props: {
  readonly text: () => string;
  readonly label?: string;
  readonly class?: string;
  readonly plain?: boolean;
}) {
  const [copied, setCopied] = createSignal(false);
  let flash: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(flash);
  });

  const copy = async (): Promise<void> => {
    if (!(await copyText(props.text()))) {
      return;
    }
    setCopied(true);
    flash = setTimeout(() => {
      setCopied(false);
    }, FLASH_MS);
  };

  return (
    <button
      type="button"
      title={props.label ?? "Copy"}
      aria-label={props.label ?? "Copy"}
      class={`flex shrink-0 items-center justify-center hover:text-neutral-50 ${props.plain ? "size-6 text-neutral-400" : "size-7 rounded-lg bg-neutral-850 text-neutral-350 hover:bg-neutral-800"} ${props.class ?? ""}`}
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
