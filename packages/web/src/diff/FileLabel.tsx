import { createMemo, For } from "solid-js";

import type { ChangeStatus, ChangeSummary } from "#protocol/Diff";
import { Fitted } from "../ui/Fitted";
import { FileTitle, type Role } from "./FileTitle";

const LETTERS = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
} as const satisfies Record<ChangeStatus, string>;

const LETTER_CLASSES = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-rose-400",
  renamed: "text-indigo-300",
  untracked: "text-neutral-400",
} as const satisfies Record<ChangeStatus, string>;

/** What leads to the name, the name itself, and the half of a move that is
    gone — struck exactly as the patch tool strikes it. */
const ROLES = {
  lead: "text-neutral-400",
  name: "text-neutral-100",
  gone: "text-neutral-400 line-through",
} as const satisfies Record<Role, string>;

/** What happened to a file and what it is called, as wide as the box holding it allows. */
export function FileLabel(props: { readonly file: ChangeSummary }) {
  const readings = createMemo(() =>
    FileTitle.readings(props.file.path, props.file.oldPath)
  );

  return (
    <>
      <span
        class={`w-3 shrink-0 font-bold ${LETTER_CLASSES[props.file.status]}`}
      >
        {LETTERS[props.file.status]}
      </span>
      <Fitted class="flex-1" texts={[FileTitle.widest(readings())]}>
        {(columns) => (
          <For each={FileTitle.fit(readings(), columns)}>
            {(piece) => <span class={ROLES[piece.role]}>{piece.text}</span>}
          </For>
        )}
      </Fitted>
    </>
  );
}
