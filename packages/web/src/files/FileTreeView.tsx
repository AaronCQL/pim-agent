import {
  createEffect,
  createMemo,
  For,
  Match,
  Show,
  Switch,
  useContext,
} from "solid-js";

import type { ChangeStatus, ChangeSummary, FolderEntry } from "#protocol/Diff";
import { comments, ReviewComments } from "../diff/Comments";
import { LETTER_CLASSES, LETTERS } from "../diff/FileLabel";
import { FIELD_BARE, FIELD_BOX, ROW_ACTIVE } from "../ui/classes";
import { FileIcon } from "./FileIcon";
import type { FileStore } from "./FileStore";
import { FileTree, type TreeRow } from "./FileTree";

const COLUMN = "flex w-[3ch] shrink-0 justify-center";

const ROW =
  "relative flex h-7 w-full min-w-0 shrink-0 items-center pr-3 text-left text-sm";

function keyOf(row: TreeRow): string {
  if (row.kind === "note") {
    return `!${row.folder}`;
  }
  return `${row.lead === undefined ? "" : "?"}${row.entry.path}`;
}

function entryOf(row: TreeRow) {
  return row.kind === "entry" ? row : undefined;
}

function noteOf(row: TreeRow) {
  return row.kind === "note" ? row : undefined;
}

function indent(depth: number): string {
  return `calc(${depth * 3}ch + 8px)`;
}

function Guides(props: { readonly depth: number }) {
  return (
    <>
      {Array.from({ length: props.depth }, (_, level) => (
        <span
          class={`${COLUMN} absolute inset-y-0`}
          style={{ left: indent(level) }}
          aria-hidden="true"
        >
          <span class="w-px bg-neutral-800" />
        </span>
      ))}
    </>
  );
}

export function FileTreeView(props: {
  readonly files: FileStore;
  readonly changes: ReadonlyMap<string, ChangeSummary>;
  readonly inset: number;
  readonly onPick: (path: string) => void;
}) {
  const notes = useContext(ReviewComments)();
  let list!: HTMLDivElement;

  const filtering = createMemo(() => props.files.state.filter.trim() !== "");

  const found = createMemo(() =>
    filtering() ? props.files.found() : undefined
  );

  const failure = createMemo(() => {
    const hits = found();
    return hits?.kind === "error" ? hits.message : undefined;
  });

  const rows = createMemo<readonly TreeRow[]>(() => {
    if (!filtering()) {
      return props.files.rows();
    }
    const hits = found();
    return hits?.kind === "ready" ? FileTree.hits(hits.value) : [];
  });

  const empty = createMemo(() =>
    filtering()
      ? found()?.kind === "ready" && rows().length === 0
      : props.files.folders[""]?.kind === "ready" && rows().length === 0
  );

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
    () => {
      const path = props.files.state.selected;
      return rows().some((row) => entryOf(row)?.entry.path === path)
        ? path
        : undefined;
    },
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
          <Show when={failure()}>
            {(message) => (
              <p class="px-3 py-1 text-sm whitespace-pre-wrap text-rose-400">
                {message()}
              </p>
            )}
          </Show>
          <Show when={empty()}>
            <p class="px-3 py-1 text-sm text-neutral-500">
              {filtering() ? "No file matches." : "No files."}
            </p>
          </Show>
          <For each={rows()} keyed={keyOf}>
            {(row) => (
              <Switch>
                <Match when={noteOf(row())}>
                  {(note) => (
                    <p
                      class={`relative flex min-h-7 shrink-0 items-center pr-3 text-sm ${note().failed ? "text-rose-400" : "text-neutral-500"}`}
                      style={{ "padding-left": indent(note().depth) }}
                    >
                      <Guides depth={note().depth} />
                      <span class={COLUMN} aria-hidden="true" />
                      <span class="min-w-0 flex-1 py-1 whitespace-pre-wrap">
                        {note().text}
                      </span>
                    </p>
                  )}
                </Match>
                <Match when={entryOf(row())}>
                  {(entryRow) => {
                    const entry = (): FolderEntry => entryRow().entry;
                    const folder = (): boolean => entry().kind === "folder";
                    const open = (): boolean =>
                      props.files.isOpen(entry().path);
                    const selected = (): boolean =>
                      props.files.state.selected === entry().path;
                    const badge = (): number => notes?.count(entry().path) ?? 0;
                    return (
                      <button
                        type="button"
                        role="treeitem"
                        data-path={entry().path}
                        title={entry().path}
                        aria-expanded={
                          folder() ? (open() ? "true" : "false") : undefined
                        }
                        aria-selected={selected() ? "true" : "false"}
                        class={`${ROW} ${selected() ? `${ROW_ACTIVE} text-neutral-50` : "text-neutral-300 hover:bg-neutral-900"}`}
                        style={{ "padding-left": indent(entryRow().depth) }}
                        onClick={() => {
                          if (folder()) {
                            props.files.toggle(entry().path);
                          } else {
                            props.onPick(entry().path);
                          }
                        }}
                      >
                        <Guides depth={entryRow().depth} />
                        <span
                          class={`${COLUMN} items-center`}
                          aria-hidden="true"
                        >
                          <span
                            class={`size-3.5 ${folder() ? `${FileIcon.folder(open())} text-neutral-400` : `${FileIcon.file(entry().name)} text-neutral-500`}`}
                          />
                        </span>
                        <span class="flex min-w-0 flex-1">
                          <Show when={entryRow().lead}>
                            {(lead) => (
                              <span class="truncate text-neutral-500">
                                {lead()}
                              </span>
                            )}
                          </Show>
                          <span
                            class={`whitespace-pre ${entryRow().lead === undefined ? "truncate" : "shrink-0"}`}
                          >
                            {entry().name}
                          </span>
                        </span>
                        <Show when={badge() > 0}>
                          <span
                            class="i-griddy-icons:chat-bubble-dots ml-1.5 size-3.5 shrink-0 text-indigo-300"
                            role="img"
                            aria-label={comments(badge())}
                          />
                        </Show>
                        <Show
                          when={folder() ? undefined : status(entry().path)}
                          fallback={
                            <Show
                              when={folder() && touched().has(entry().path)}
                            >
                              <span
                                class="mr-0.5 ml-2 size-1.5 shrink-0 rounded-full bg-amber-400/70"
                                role="img"
                                aria-label="holds changes"
                              />
                            </Show>
                          }
                        >
                          {(changed) => (
                            <span
                              class={`ml-1.5 w-3 shrink-0 text-center text-xs font-bold ${LETTER_CLASSES[changed()]}`}
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
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
