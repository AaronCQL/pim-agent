import { createMemo, createSignal, For, Show, useContext } from "solid-js";

import type { ToolDiffHunk } from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import type { ChangeSummary } from "#protocol/Diff";
import { createAnchoring } from "../diff/anchoring";
import { ReviewComments } from "../diff/Comments";
import { FileTitle } from "../diff/FileTitle";
import { LETTER_CLASSES, LETTERS, ROLES } from "../diff/FileLabel";
import { Stat } from "../diff/Stat";
import { Format } from "#core/shared/Format";
import { CopyButton } from "../ui/CopyButton";
import { Fade } from "../ui/Fade";
import { Fitted } from "../ui/Fitted";
import { QUIET } from "../ui/classes";
import { Spinner } from "../ui/Spinner";
import { UnifiedLines } from "../view/Blocks";
import type { ChangeMarkMap } from "../view/ChangeMarks";
import type { FileStore } from "./FileStore";

/** Lines per highlighted block; the highlighter gives up on longer ones. */
const CHUNK = 1000;

/** Blocks painted per page. */
const PAGE = 3;

const LEAD = "text-neutral-400";

function chunks(lines: readonly string[]): readonly ToolDiffHunk[] {
  const out: ToolDiffHunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK) {
    const slice = lines.slice(start, start + CHUNK);
    out.push({
      oldStart: start + 1,
      oldLines: slice.length,
      newStart: start + 1,
      newLines: slice.length,
      lines: slice.map((text, at) => ({
        kind: "context",
        oldLine: start + at + 1,
        newLine: start + at + 1,
        text,
      })),
    });
  }
  return out;
}

function PathTitle(props: { readonly path: string }) {
  const readings = createMemo(() => FileTitle.readings(props.path, undefined));
  return (
    <Fitted class="flex-1" texts={[FileTitle.widest(readings())]}>
      {(columns) => (
        <For each={FileTitle.fit(readings(), columns)}>
          {(piece) => <span class={ROLES[piece.role]}>{piece.text}</span>}
        </For>
      )}
    </Fitted>
  );
}

/** The file's lines, with gutters that take comments like the diff's. */
function FileLines(props: {
  readonly path: string;
  readonly fingerprint: string;
  readonly lines: readonly string[];
  readonly marks: ChangeMarkMap | undefined;
}) {
  const notes = useContext(ReviewComments)();
  const [pages, setPages] = createSignal(1);
  const lang = createMemo(() => Languages.fromPath(props.path));
  const all = createMemo(() => chunks(props.lines));
  const shown = createMemo(() => all().slice(0, pages() * PAGE));
  const width = createMemo(() => String(props.lines.length).length);

  const anchoring =
    notes === undefined
      ? undefined
      : createAnchoring({
          comments: notes,
          file: () => ({ path: props.path, fingerprint: props.fingerprint }),
          hunks: shown,
        });

  const painted = createMemo(() =>
    shown().reduce((total, hunk) => total + hunk.lines.length, 0)
  );

  return (
    <div class="text-sm">
      <div class="px-3" style={{ "--gutter": `${width() + 4}ch` }}>
        {anchoring?.fileCards()}
      </div>
      <div
        class="w-max min-w-full pt-1 leading-[--line] text-neutral-300 [tab-size:3]"
        style={{ "--gutter": `${width() + 4}ch` }}
      >
        <For each={shown()}>
          {(hunk) => (
            <UnifiedLines
              lines={hunk.lines}
              lang={lang()}
              width={width()}
              anchors={anchoring}
              marks={props.marks}
            />
          )}
        </For>
      </div>
      <Show when={painted() < props.lines.length}>
        <div class={`flex items-center gap-2 px-3 py-2 ${LEAD}`}>
          <span class="tabular-nums">
            {painted().toLocaleString()} of{" "}
            {props.lines.length.toLocaleString()} lines
          </span>
          <button
            type="button"
            class={QUIET}
            onClick={() => {
              setPages((count) => count + 1);
            }}
          >
            show more
          </button>
        </div>
      </Show>
      {anchoring?.sheet()}
    </div>
  );
}

export function FileViewer(props: {
  readonly files: FileStore;
  readonly change: ChangeSummary | undefined;
  readonly marks: ChangeMarkMap | undefined;
  readonly inset: number;
  readonly onDiff: (path: string) => void;
  /** Present where the tree is out of sight. */
  readonly onBrowse?: () => void;
}) {
  const ready = createMemo(() => {
    const view = props.files.view();
    return view?.kind === "ready" ? view : undefined;
  });

  const failed = createMemo(() => {
    const view = props.files.view();
    return view?.kind === "error" ? view : undefined;
  });

  const fingerprint = (): string =>
    props.change?.fingerprint ?? ready()?.file.fingerprint ?? "";

  const meta = createMemo(() => {
    const view = ready();
    if (view === undefined) {
      return "";
    }
    const bytes = Format.bytes(view.file.bytes);
    return view.file.text === undefined
      ? bytes
      : `${Format.count(view.lines.length, "line")} · ${bytes}`;
  });

  return (
    <Show
      when={props.files.state.selected}
      keyed
      fallback={
        <p class="flex h-full items-center justify-center text-sm text-neutral-500">
          Pick a file to read it.
        </p>
      }
    >
      {(path) => (
        <div class="flex h-full min-h-0 flex-col">
          <div class="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-sm">
            <Show when={props.onBrowse !== undefined}>
              <button
                type="button"
                aria-label="Show the files"
                title="Show the files"
                class="-ml-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-50"
                onClick={() => {
                  props.onBrowse?.();
                }}
              >
                <span class="i-griddy-icons:folder size-4" aria-hidden="true" />
              </button>
            </Show>
            <PathTitle path={path} />
            <span class="hidden shrink-0 text-neutral-500 tabular-nums md:inline">
              {meta()}
            </span>
            <Show when={props.change}>
              {(change) => (
                <>
                  <span
                    class={`shrink-0 font-bold ${LETTER_CLASSES[change().status]}`}
                    role="img"
                    aria-label={change().status}
                  >
                    {LETTERS[change().status]}
                  </span>
                  <Show when={!change().binary}>
                    <Stat added={change().added} removed={change().removed} />
                  </Show>
                  <button
                    type="button"
                    title="Show this file's changes"
                    class={`${QUIET} h-7 px-2`}
                    onClick={() => {
                      props.onDiff(path);
                    }}
                  >
                    Diff
                  </button>
                </>
              )}
            </Show>
            <CopyButton text={() => path} label="Copy path" />
          </div>
          <div class="isolate min-h-0 flex-1 overflow-auto">
            <div style={{ "padding-bottom": `${props.inset}px` }}>
              <Show when={props.files.view()?.kind === "loading"}>
                <span
                  class={`flex items-center gap-2 px-3 py-2 text-sm ${LEAD}`}
                >
                  <Spinner />
                  reading the file
                </span>
              </Show>
              <Show when={failed()}>
                {(view) => (
                  <p class="px-3 py-2 text-sm whitespace-pre-wrap text-rose-400">
                    {view().message}
                  </p>
                )}
              </Show>
              <Show when={ready()}>
                {(view) => (
                  <Show
                    when={view().file.text !== undefined}
                    fallback={
                      <p class={`px-3 py-2 text-sm ${LEAD}`}>
                        {view().file.binary === true
                          ? "binary file — nothing to show"
                          : "too large to show"}
                      </p>
                    }
                  >
                    <Show
                      when={view().lines.length > 0}
                      fallback={
                        <p class={`px-3 py-2 text-sm ${LEAD}`}>empty file</p>
                      }
                    >
                      <FileLines
                        path={path}
                        fingerprint={fingerprint()}
                        lines={view().lines}
                        marks={props.marks}
                      />
                    </Show>
                  </Show>
                )}
              </Show>
            </div>
            <Fade height={props.inset} />
          </div>
        </div>
      )}
    </Show>
  );
}
