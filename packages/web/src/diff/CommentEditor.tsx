import { createMemo, createSignal, onSettled, Show, untrack } from "solid-js";

import type { ToolDiffLine } from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import { baseName } from "../format";
import { ACTION, QUIET } from "../ui/classes";
import { Modal } from "../ui/Modal";
import { UnifiedLines } from "../view/Blocks";

/** Used for both saved and in-progress comments. */
export function CommentEditor(props: {
  readonly path: string;
  readonly text: string;
  /** The file changed since this was written. */
  readonly stale: boolean;
  /** Focus on mount. */
  readonly focus?: boolean;
  /** False on touch devices, where a tap opens the sheet instead. */
  readonly editable: boolean;
  readonly onWrite: (text: string) => void;
  /** Tap on a non-editable card. */
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
  /** Blurred while blank; unlike `onRemove`, the card may stay open. */
  readonly onDiscard?: () => void;
  readonly onRemove: () => void;
}) {
  let box: HTMLTextAreaElement | undefined;

  onSettled(() => {
    if (untrack(() => props.focus === true)) {
      box?.focus();
    }
  });

  return (
    <div class="relative ml-[var(--gutter,0px)] max-w-[calc(100vw-3rem)] bg-indigo-500/10 inset-ring inset-ring-indigo-400/40 focus-within:inset-ring-indigo-400/70 text-indigo-200">
      <Margin
        path={props.path}
        stale={props.stale}
        onRemove={() => {
          props.onRemove();
        }}
      />
      <textarea
        ref={(element: HTMLTextAreaElement) => {
          box = element;
        }}
        aria-label={`Comment on ${props.path}`}
        placeholder="What should change here?"
        readonly={!props.editable}
        value={props.text}
        class="block w-full resize-none bg-transparent px-3 py-[calc(var(--line)/2)] leading-[--line] outline-none [field-sizing:content] placeholder:text-indigo-200/50"
        onInput={(event) => {
          props.onWrite(event.currentTarget.value);
        }}
        onClick={() => {
          if (!props.editable) {
            props.onOpen?.();
          }
        }}
        onBlur={(event) => {
          if (event.currentTarget.value.trim() === "") {
            props.onDiscard?.();
          }
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            box?.blur();
            props.onClose?.();
          }
        }}
      />
    </div>
  );
}

function Margin(props: {
  readonly path: string;
  readonly stale: boolean;
  readonly onRemove: () => void;
}) {
  // Centres the button on the gutter's last digit, 3.5ch left of the card.
  return (
    <div class="absolute top-[calc(var(--line)-0.75rem)] right-full mr-[calc(3.5ch-0.75rem)] flex flex-col items-end gap-0.5">
      <button
        type="button"
        aria-label={`Delete the comment on ${props.path}`}
        title="Delete this comment"
        class="flex size-6 items-center justify-center rounded text-indigo-200/70 hover:bg-indigo-500/15 hover:text-indigo-200"
        onClick={() => {
          props.onRemove();
        }}
      >
        <span class="i-griddy-icons:close size-3.5" aria-hidden="true" />
      </button>
      <Show when={props.stale}>
        <span class="rounded bg-amber-500/15 px-1 text-xs text-amber-400">
          Stale
        </span>
      </Show>
    </div>
  );
}

/** Touch-device editor in a modal, with explicit save/cancel. */
export function CommentSheet(props: {
  readonly open: boolean;
  readonly path: string;
  readonly quote: readonly ToolDiffLine[];
  /** Gutter width of the file's diff, in characters. */
  readonly width: number;
  readonly text: string;
  readonly onCancel: () => void;
  readonly onSave: (text: string) => void;
}) {
  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      label="Comment"
      size="narrow"
      header={
        <div class="truncate font-bold leading-[--line]">
          {baseName(props.path)}
        </div>
      }
    >
      <Show when={props.open}>
        <SheetBody
          path={props.path}
          quote={props.quote}
          width={props.width}
          text={props.text}
          onCancel={props.onCancel}
          onSave={props.onSave}
        />
      </Show>
    </Modal>
  );
}

function SheetBody(props: {
  readonly path: string;
  readonly quote: readonly ToolDiffLine[];
  readonly width: number;
  readonly text: string;
  readonly onCancel: () => void;
  readonly onSave: (text: string) => void;
}) {
  const [draft, setDraft] = createSignal(untrack(() => props.text));
  const lang = createMemo(() => Languages.fromPath(props.path));
  let box: HTMLTextAreaElement | undefined;

  // `autofocus` covers the dialog's own focusing; this covers an already-open dialog.
  onSettled(() => {
    box?.focus();
  });

  return (
    <>
      <Show when={props.quote.length > 0}>
        <div class="min-h-0 overflow-auto overscroll-contain border-b border-neutral-700 py-[calc(var(--line)/2)]">
          <div class="w-max min-w-full leading-[--line] text-neutral-300 [tab-size:3]">
            <UnifiedLines
              lines={props.quote}
              lang={lang()}
              width={props.width}
            />
          </div>
        </div>
      </Show>
      <div class="mt-auto flex shrink-0 flex-col gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <textarea
          ref={(element: HTMLTextAreaElement) => {
            box = element;
          }}
          autofocus
          rows={3}
          aria-label={`Comment on ${props.path}`}
          placeholder="What should change here?"
          value={draft()}
          class="max-h-60 w-full resize-none rounded-lg bg-indigo-500/10 px-3 py-[calc(var(--line)/2)] leading-[--line] text-indigo-200 outline-none inset-ring inset-ring-indigo-400/40 focus:inset-ring-indigo-400/70 placeholder:text-indigo-200/50 [field-sizing:content]"
          onInput={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
        <div class="flex shrink-0 items-center justify-end gap-2">
          <button type="button" class={QUIET} onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            class={ACTION}
            disabled={draft().trim() === ""}
            onClick={() => {
              props.onSave(draft());
            }}
          >
            Comment
          </button>
        </div>
      </div>
    </>
  );
}
