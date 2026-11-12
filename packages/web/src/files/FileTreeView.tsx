import { createEffect, createMemo, For, Show, useContext } from "solid-js";

import type { ChangeStatus, ChangeSummary } from "#protocol/Diff";
import { comments, ReviewComments } from "../diff/Comments";
import { LETTER_CLASSES, LETTERS } from "../diff/FileLabel";
import { baseName } from "../format";
import { FIELD_BARE, FIELD_BOX, ROW_ACTIVE } from "../ui/classes";
import type { FileStore } from "./FileStore";
import { FileTree, type TreeNode } from "./FileTree";

const INDENT_PX = 12;

const ROW =
  "flex h-7 w-full min-w-0 shrink-0 items-center gap-1.5 pr-3 text-left text-sm";

type Row = {
  readonly node: TreeNode;
  readonly depth: number;
  /** Set on a filter hit, which shows its whole path. */
  readonly lead?: string;
};

export function FileTreeView(props: {
  readonly files: FileStore;
  readonly changes: ReadonlyMap<string, ChangeSummary>;
  readonly inset: number;
  readonly onPick: (path: string) => void;
}) {
  const notes = useContext(ReviewComments)();
  let list!: HTMLDivElement;

  const filtering = createMemo(() => props.files.state.filter.trim() !== "");

  const rows = createMemo<readonly Row[]>(() => {
    if (!filtering()) {
      return FileTree.rows(props.files.tree(), (path) =>
        props.files.isOpen(path)
      );
    }
    return FileTree.match(props.files.paths(), props.files.state.filter).map(
      (path) => {
        const name = baseName(path);
        return {
          node: { name, path },
          depth: 0,
          lead: path.slice(0, path.length - name.length),
        };
      }
    );
  });

  /** Folders holding a change, so a closed one still shows it. */
  const touched = createMemo(() => {
    const folders = new Set<string>();
    for (const path of props.changes.keys()) {
      for (const folder of FileTree.ancestors(path)) {
        folders.add(folder);
      }
    }
    return folders;
  });

  createEffect(
    () => props.files.state.selected,
    (path) => {
      if (path === undefined) {
        return;
      }
      for (const row of list.querySelectorAll<HTMLElement>("[data-path]")) {
        if (row.dataset.path === path) {
          row.scrollIntoView({ block: "nearest" });
        }
      }
    }
  );

  const status = (path: string): ChangeStatus | undefined =>
    props.changes.get(path)?.status;

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="shrink-0 p-2">
        <label class={FIELD_BOX}>
          <span
            class="i-griddy-icons:search size-4 shrink-0 text-neutral-500"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Filter files"
            placeholder="Filter files"
            class={FIELD_BARE}
            value={props.files.state.filter}
            onInput={(event) => {
              props.files.setFilter(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                props.files.setFilter("");
              }
            }}
          />
        </label>
      </div>
      <div
        ref={(element: HTMLDivElement) => {
          list = element;
        }}
        role="tree"
        aria-label="Files"
        class="isolate min-h-0 flex-1 overflow-y-auto"
      >
        <div
          class="flex flex-col"
          style={{ "padding-bottom": `${props.inset}px` }}
        >
          <Show when={props.files.state.error}>
            {(message) => (
              <p class="px-3 py-1 text-sm whitespace-pre-wrap text-rose-400">
                {message()}
              </p>
            )}
          </Show>
          <Show
            when={
              props.files.state.status === "ready" &&
              props.files.state.error === undefined &&
              rows().length === 0
            }
          >
            <p class="px-3 py-1 text-sm text-neutral-500">
              {filtering() ? "No file matches." : "No files."}
            </p>
          </Show>
          <For
            each={rows()}
            keyed={(row) =>
              `${row.lead === undefined ? "" : "?"}${row.node.path}`
            }
          >
            {(row) => {
              const folder = (): boolean => row().node.children !== undefined;
              const open = (): boolean => props.files.isOpen(row().node.path);
              const selected = (): boolean =>
                props.files.state.selected === row().node.path;
              const badge = (): number => notes?.count(row().node.path) ?? 0;
              return (
                <button
                  type="button"
                  role="treeitem"
                  data-path={row().node.path}
                  title={row().node.path}
                  aria-expanded={
                    folder() ? (open() ? "true" : "false") : undefined
                  }
                  aria-selected={selected() ? "true" : "false"}
                  class={`${ROW} ${selected() ? `${ROW_ACTIVE} text-neutral-50` : "text-neutral-300 hover:bg-neutral-900"}`}
                  style={{ "padding-left": `${row().depth * INDENT_PX + 8}px` }}
                  onClick={() => {
                    if (folder()) {
                      props.files.toggle(row().node.path);
                    } else {
                      props.onPick(row().node.path);
                    }
                  }}
                >
                  <Show when={row().lead === undefined}>
                    <span
                      class={`size-4 shrink-0 text-neutral-500 ${folder() ? `i-griddy-icons:chevron-right-small-filled transition-transform ${open() ? "rotate-90" : ""}` : ""}`}
                      aria-hidden="true"
                    />
                  </Show>
                  <span class="flex min-w-0 flex-1">
                    <Show when={row().lead}>
                      {(lead) => (
                        <span class="truncate text-neutral-500">{lead()}</span>
                      )}
                    </Show>
                    <span
                      class={`whitespace-pre ${row().lead === undefined ? "truncate" : "shrink-0"}`}
                    >
                      {row().node.name}
                    </span>
                  </span>
                  <Show when={badge() > 0}>
                    <span
                      class="i-griddy-icons:chat-bubble-dots size-3.5 shrink-0 text-indigo-300"
                      role="img"
                      aria-label={comments(badge())}
                    />
                  </Show>
                  <Show
                    when={folder() ? undefined : status(row().node.path)}
                    fallback={
                      <Show when={folder() && touched().has(row().node.path)}>
                        <span
                          class="mx-0.5 size-1.5 shrink-0 rounded-full bg-amber-400/70"
                          role="img"
                          aria-label="holds changes"
                        />
                      </Show>
                    }
                  >
                    {(changed) => (
                      <span
                        class={`w-3 shrink-0 text-center text-xs font-bold ${LETTER_CLASSES[changed()]}`}
                        role="img"
                        aria-label={changed()}
                      >
                        {LETTERS[changed()]}
                      </span>
                    )}
                  </Show>
                </button>
              );
            }}
          </For>
          <Show when={props.files.state.truncated}>
            <p class="px-3 py-1 text-sm text-amber-400">
              More files exist than this list holds.
            </p>
          </Show>
        </div>
      </div>
    </div>
  );
}
