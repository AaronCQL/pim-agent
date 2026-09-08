import { For } from "solid-js";

import { version } from "../../../../package.json";

const shortcuts = [
  ["Escape", "Cancel autocomplete / abort turn"],
  ["/<command>", "Slash commands"],
  ["@<path>", "Reference a file"],
  ["Ctrl/⌘ + Enter", "Send message"],
] as const;

export function Splash() {
  return (
    <section
      aria-label="Pim controls"
      class="max-w-md space-y-[--line] text-base"
    >
      <h2 class="font-bold text-indigo-300">
        PIM - Pi IMproved{" "}
        <span class="font-normal italic text-neutral-500">{`v${version}`}</span>
      </h2>
      <dl class="space-y-1">
        <For each={shortcuts}>
          {([shortcut, description]) => (
            <div class="grid grid-cols-[max-content_1fr] gap-x-1ch">
              <dt class="text-pink-400">{shortcut}</dt>
              <dd class="text-neutral-500">{description}</dd>
            </div>
          )}
        </For>
      </dl>
    </section>
  );
}
