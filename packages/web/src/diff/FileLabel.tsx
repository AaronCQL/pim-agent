import type { ChangeStatus, ChangeSummary } from "#protocol/Diff";
import { PathTitle } from "./PathTitle";

export const LETTERS = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
} as const satisfies Record<ChangeStatus, string>;

export const LETTER_CLASSES = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-rose-400",
  renamed: "text-indigo-300",
  untracked: "text-neutral-400",
} as const satisfies Record<ChangeStatus, string>;

export function FileLabel(props: { readonly file: ChangeSummary }) {
  return (
    <>
      <span
        class={`w-3 shrink-0 font-bold ${LETTER_CLASSES[props.file.status]}`}
      >
        {LETTERS[props.file.status]}
      </span>
      <PathTitle
        path={props.file.path}
        oldPath={props.file.oldPath}
        class="flex-1"
      />
    </>
  );
}
