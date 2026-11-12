import { createMemo, For } from "solid-js";

import { Fitted } from "../ui/Fitted";
import { FileTitle, type Role } from "./FileTitle";

const ROLES = {
  lead: "text-neutral-400",
  name: "text-neutral-100",
  gone: "text-neutral-400 line-through",
} as const satisfies Record<Role, string>;

export function PathTitle(props: {
  readonly path: string;
  readonly oldPath?: string;
  readonly class?: string;
}) {
  const readings = createMemo(() =>
    FileTitle.readings(props.path, props.oldPath)
  );
  return (
    <Fitted class={props.class} texts={[FileTitle.widest(readings())]}>
      {(columns) => (
        <For each={FileTitle.fit(readings(), columns)}>
          {(piece) => <span class={ROLES[piece.role]}>{piece.text}</span>}
        </For>
      )}
    </Fitted>
  );
}
