const BOX =
  "peer size-4 appearance-none rounded bg-neutral-850 ring-1 ring-neutral-700 outline-none hover:ring-neutral-600 checked:bg-indigo-400 checked:ring-0 checked:hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:opacity-40 disabled:hover:ring-neutral-700";

/** A checkbox: the native input painted as the box, with the tick drawn over it. */
export function Check(props: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <span class="relative flex size-4 shrink-0 items-center justify-center">
      <input
        type="checkbox"
        class={BOX}
        checked={props.checked}
        disabled={props.disabled === true}
        aria-label={props.label}
        onChange={(event: Event) => {
          props.onChange((event.currentTarget as HTMLInputElement).checked);
        }}
      />
      <span
        class="i-griddy-icons:check pointer-events-none absolute size-3 text-neutral-950 opacity-0 peer-checked:opacity-100"
        aria-hidden="true"
      />
    </span>
  );
}
