import { createMemo, Show } from "solid-js";

import type { ChangeSummary } from "#protocol/Diff";
import { ACTION } from "../ui/classes";
import { Spinner } from "../ui/Spinner";

/** A rename goes on the pathspec by both of its names, or its old one is left behind. */
function pathsOf(files: readonly ChangeSummary[]): readonly string[] {
  return files.flatMap((file) =>
    file.oldPath === undefined ? [file.path] : [file.path, file.oldPath]
  );
}

function total(
  files: readonly ChangeSummary[],
  side: "added" | "removed"
): number {
  return files.reduce((sum, file) => sum + file[side], 0);
}

/** The end of a review: what was picked, a message for it, and the button that writes it. */
export function CommitCard(props: {
  /** The picked rows, in the list's own order. */
  readonly files: readonly ChangeSummary[];
  readonly message: string;
  readonly committing: boolean;
  readonly failure: string | undefined;
  /** The short sha of the commit this card wrote. */
  readonly committed: string | undefined;
  readonly onMessage: (message: string) => void;
  readonly onCommit: (paths: readonly string[]) => void;
}) {
  const added = createMemo(() => total(props.files, "added"));
  const removed = createMemo(() => total(props.files, "removed"));
  const writable = createMemo(
    () => props.files.length > 0 && props.message.trim() !== ""
  );

  return (
    <div class="m-3 flex flex-col gap-2 rounded-lg bg-neutral-900 p-3 text-sm">
      <Show when={props.files.length > 0}>
        <div class="flex items-center gap-2">
          <span class="text-neutral-100">
            Commit {props.files.length}{" "}
            {props.files.length === 1 ? "file" : "files"}
          </span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
            <Show when={added() > 0}>
              <span class="text-emerald-400">+{added()}</span>
            </Show>
            <Show when={removed() > 0}>
              <span class="text-rose-400">−{removed()}</span>
            </Show>
          </span>
        </div>
        <textarea
          rows={2}
          aria-label="Commit message"
          placeholder="Message"
          value={props.message}
          class="max-h-30 w-full resize-none rounded-lg bg-neutral-850 px-2 py-1.5 outline-none ring-1 ring-transparent [field-sizing:content] placeholder:text-neutral-500 focus:ring-neutral-600"
          onInput={(event) => {
            props.onMessage(event.currentTarget.value);
          }}
        />
      </Show>
      <Show when={props.failure}>
        {(message) => (
          <p class="whitespace-pre-wrap text-rose-400">{message()}</p>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <Show when={props.committed}>
          {(sha) => <span class="text-emerald-400">committed {sha()}</span>}
        </Show>
        <Show when={props.files.length > 0}>
          <button
            type="button"
            class={`${ACTION} ml-auto flex items-center gap-2`}
            disabled={!writable() || props.committing}
            onClick={() => {
              props.onCommit(pathsOf(props.files));
            }}
          >
            <Show when={props.committing}>
              <Spinner />
            </Show>
            Commit
          </button>
        </Show>
      </div>
    </div>
  );
}
