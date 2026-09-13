import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js";

import { Format } from "#core/shared/Format";
import type { ChangeSummary } from "#protocol/Diff";
import { ACTION } from "../ui/classes";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { FileLabel } from "./FileLabel";
import { Stat } from "./Stat";

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

function pathsIn(files: readonly ChangeSummary[]): ReadonlySet<string> {
  return new Set(files.map((file) => file.path));
}

function Tick(props: { readonly on: boolean }) {
  return (
    <span
      class={
        props.on
          ? "i-griddy-icons:checkbox-filled size-4 shrink-0 text-indigo-400"
          : "i-griddy-icons:checkbox size-4 shrink-0"
      }
      aria-hidden="true"
    />
  );
}

/** The end of a review: which of the changed files go in, and the message over them. */
export function CommitModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Every changed file, in the list's own order. */
  readonly files: readonly ChangeSummary[];
  readonly message: string;
  readonly committing: boolean;
  readonly failure: string | undefined;
  readonly onMessage: (message: string) => void;
  readonly onCommit: (paths: readonly string[]) => void;
}) {
  const [picks, setPicks] = createSignal<ReadonlySet<string>>(new Set());
  let box: HTMLTextAreaElement | undefined;

  // Born fresh on every open, over the list as it stands then: picks that
  // outlived the modal would have to be revalidated against an edited tree.
  createEffect(
    () => props.open,
    (open) => {
      if (open) {
        setPicks(pathsIn(untrack(() => props.files)));
        box?.focus();
      }
    }
  );

  const picked = createMemo(() =>
    props.files.filter((file) => picks().has(file.path))
  );
  const every = createMemo(
    () => props.files.length > 0 && picked().length === props.files.length
  );
  const writable = createMemo(
    () => picked().length > 0 && props.message.trim() !== ""
  );

  const toggle = (path: string): void => {
    setPicks((held) => {
      const next = new Set(held);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  };

  const write = (): void => {
    if (writable() && !props.committing) {
      props.onCommit(pathsOf(picked()));
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      label="Commit"
      size="narrow"
      header={<div class="font-bold leading-[--line]">Commit</div>}
    >
      <Show when={props.open}>
        <div class="flex shrink-0 items-center gap-2 border-b border-neutral-700 px-3 py-1.5 text-sm">
          <button
            type="button"
            role="checkbox"
            aria-checked={every() ? "true" : "false"}
            aria-label={every() ? "Clear every pick" : "Pick every file"}
            class="flex shrink-0 items-center text-neutral-500 hover:text-neutral-100"
            onClick={() => {
              setPicks(every() ? new Set<string>() : pathsIn(props.files));
            }}
          >
            <Tick on={every()} />
          </button>
          <span class="text-neutral-400 tabular-nums">
            {Format.count(props.files.length, "file")}
          </span>
          <span class="ml-auto">
            <Stat
              added={total(picked(), "added")}
              removed={total(picked(), "removed")}
            />
          </span>
        </div>

        <div class="min-h-0 overflow-y-auto py-1">
          <For each={props.files}>
            {(file) => (
              <button
                type="button"
                role="checkbox"
                aria-checked={picks().has(file.path) ? "true" : "false"}
                aria-label={file.path}
                class="flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-neutral-900"
                onClick={() => {
                  toggle(file.path);
                }}
              >
                <Tick on={picks().has(file.path)} />
                <span
                  class={`flex min-w-0 flex-1 items-center gap-2 ${picks().has(file.path) ? "" : "opacity-40"}`}
                >
                  <FileLabel file={file} />
                  <Stat added={file.added} removed={file.removed} />
                </span>
              </button>
            )}
          </For>
        </div>

        <Show when={props.failure}>
          {(message) => (
            <p class="shrink-0 px-3 pt-2 text-sm whitespace-pre-wrap text-rose-400">
              {message()}
            </p>
          )}
        </Show>

        {/* The message and the button it arms are one row: what is typed and
            what it does belong to each other, and the width a wide screen
            gives this modal goes into the field rather than between them. */}
        <div class="flex shrink-0 items-end gap-2 border-t border-neutral-700 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <textarea
            ref={(element: HTMLTextAreaElement) => {
              box = element;
            }}
            rows={1}
            aria-label="Commit message"
            placeholder="Message"
            value={props.message}
            class="max-h-40 min-w-0 flex-1 resize-none rounded-lg bg-neutral-850 px-2 py-1.5 text-sm outline-none ring-1 ring-transparent [field-sizing:content] placeholder:text-neutral-500 focus:ring-neutral-600"
            onInput={(event) => {
              props.onMessage(event.currentTarget.value);
            }}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                write();
              }
            }}
          />
          <button
            type="button"
            class={`${ACTION} flex items-center gap-2`}
            disabled={!writable() || props.committing}
            onClick={write}
          >
            <Show when={props.committing}>
              <Spinner />
            </Show>
            Commit
          </button>
        </div>
      </Show>
    </Modal>
  );
}
