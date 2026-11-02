import { For } from "solid-js";

import { CHIP_GROUP, CHIP_SEGMENT } from "../ui/classes";

export type ReviewMode = "changes" | "files";

const MODES = [
  { value: "changes", label: "Changes", icon: "i-griddy-icons:code-compare" },
  { value: "files", label: "Files", icon: "i-griddy-icons:folder" },
] as const satisfies readonly {
  readonly value: ReviewMode;
  readonly label: string;
  readonly icon: string;
}[];

export function ModeSwitch(props: {
  readonly mode: ReviewMode;
  readonly onMode: (mode: ReviewMode) => void;
}) {
  return (
    <div role="group" aria-label="Review mode" class={CHIP_GROUP}>
      <For each={MODES}>
        {(mode) => (
          <button
            type="button"
            aria-pressed={props.mode === mode.value ? "true" : "false"}
            aria-label={mode.label}
            title={mode.label}
            class={`${CHIP_SEGMENT} first:rounded-l-lg last:rounded-r-lg ${props.mode === mode.value ? "bg-neutral-700 text-neutral-50 hover:bg-neutral-700" : ""}`}
            onClick={() => {
              props.onMode(mode.value);
            }}
          >
            <span class={`${mode.icon} size-4 shrink-0`} aria-hidden="true" />
            <span class="hidden sm:inline">{mode.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}
