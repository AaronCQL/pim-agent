import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import type { SessionStore, UploadedAttachment } from "../session/SessionStore";
import { Combobox, createComboboxNavigation } from "../ui/Combobox";
import { activeToken, applyCompletion, tokenKey } from "./token";

const ANCHOR = "--pim-composer";
const FILE_LIMIT = 50;
const COMMAND_LIMIT = 20;

/**
 * The draft, the pickers over it, and the two ways bytes get in.
 *
 * Ranking never happens here: `@` names a file on the *agent's* disk and a
 * skill is a capability on the agent's disk, so both are one server query and
 * at most `limit` rows back. An upload is the opposite
 * direction and not a picker at all — the bytes are transferred into the
 * server's world first, and only the id the server answered with is ever
 * attached to a message.
 */
export function Composer(props: { readonly store: SessionStore }) {
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [items, setItems] = createSignal<readonly PickerItem[]>([]);
  // ESC closes the picker for *this* token only: remembering the dismissed key
  // rather than a boolean means the next keystroke, which moves the query,
  // re-opens it without a second gesture.
  const [dismissed, setDismissed] = createSignal("");
  const [failed, setFailed] = createSignal("");
  const [attachments, setAttachments] = createSignal<
    readonly UploadedAttachment[]
  >([]);
  const [dropping, setDropping] = createSignal(false);
  let input!: HTMLTextAreaElement;
  let generation = 0;

  const token = createMemo(() => activeToken(text(), caret()));
  const key = createMemo(() => tokenKey(token()));
  const open = createMemo(() => key() !== "" && dismissed() !== key());

  createEffect(
    () => key(),
    (current) => {
      void refine(current);
    }
  );

  async function refine(current: string): Promise<void> {
    const mine = ++generation;
    if (current === "") {
      setItems([]);
      return;
    }
    const active = token();
    if (!active) {
      return;
    }
    const rows =
      active.kind === "file"
        ? ((await props.store.files.rank(active.query, {
            limit: FILE_LIMIT,
          })) ?? [])
        : await props.store.pickCommands(active.query, COMMAND_LIMIT);
    if (mine === generation) {
      setItems(rows);
    }
  }

  const navigation = createComboboxNavigation({
    count: () => items().length,
    open: () => open() && items().length > 0,
    onSelect: (index) => {
      commit(index);
    },
    onDismiss: () => {
      setDismissed(key());
    },
  });

  function commit(index: number): void {
    const active = token();
    const item = items()[index];
    if (!active || !item) {
      return;
    }
    const completion = applyCompletion(text(), caret(), active, item);
    setText(completion.text);
    setCaret(completion.caret);
    setDismissed(
      completion.keepOpen
        ? ""
        : tokenKey(activeToken(completion.text, completion.caret))
    );
    input.value = completion.text;
    input.setSelectionRange(completion.caret, completion.caret);
    input.focus();
  }

  function track(): void {
    setText(input.value);
    setCaret(input.selectionStart ?? input.value.length);
  }

  async function absorb(files: readonly File[]): Promise<void> {
    setFailed("");
    for (const file of files) {
      try {
        const stored = await props.store.upload(file);
        setAttachments((current) => [...current, stored]);
      } catch (err) {
        setFailed(`${file.name}: ${(err as Error).message}`);
      }
    }
  }

  async function submit(): Promise<void> {
    const draft = text();
    const attached = attachments();
    if (draft.trim() === "" && attached.length === 0) {
      return;
    }
    setText("");
    setCaret(0);
    setAttachments([]);
    setItems([]);
    input.value = "";
    await props.store.prompt(draft, attached);
  }

  return (
    <div
      class={{
        "relative flex flex-col gap-2 rounded-lg border bg-neutral-900/60 p-2": true,
        "border-neutral-800": !dropping(),
        "border-sky-600 bg-sky-950/30": dropping(),
      }}
      style={{ "anchor-name": ANCHOR }}
      onDragOver={(event: DragEvent) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => {
        setDropping(false);
      }}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        setDropping(false);
        void absorb([...(event.dataTransfer?.files ?? [])]);
      }}
    >
      <Show when={attachments().length > 0}>
        <ul class="flex flex-wrap gap-1 text-xs">
          <For each={attachments()}>
            {(attachment) => (
              <li class="flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5">
                <span
                  class={
                    attachment.isImage
                      ? "i-lucide-image block"
                      : "i-lucide-paperclip block"
                  }
                  aria-hidden="true"
                />
                <span class="max-w-40 truncate">{attachment.label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.label}`}
                  class="i-lucide-x block text-neutral-500 hover:text-neutral-200"
                  onClick={() => {
                    setAttachments((current) =>
                      current.filter((one) => one.id !== attachment.id)
                    );
                  }}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>

      <textarea
        ref={(element: HTMLTextAreaElement) => {
          input = element;
        }}
        rows={2}
        placeholder="Message the agent —  @ for files, / for commands"
        aria-label="Message"
        class="min-h-16 w-full resize-y bg-transparent px-1 text-neutral-100 outline-none placeholder:text-neutral-600"
        onInput={track}
        onClick={track}
        onKeyUp={track}
        onPaste={(event: ClipboardEvent) => {
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length > 0) {
            event.preventDefault();
            void absorb(files);
          }
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (navigation.onKeyDown(event)) {
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />

      <Show when={failed()}>
        {(message) => <p class="text-xs text-red-400">{message()}</p>}
      </Show>

      <div class="flex items-center justify-between text-xs text-neutral-500">
        <span class="min-w-0 truncate font-mono">{props.store.state.cwd}</span>
        <Show
          when={props.store.isBusy()}
          fallback={
            <button
              type="button"
              class="rounded bg-neutral-800 px-3 py-1 text-neutral-200 hover:bg-neutral-700"
              onClick={() => {
                void submit();
              }}
            >
              Send
            </button>
          }
        >
          <button
            type="button"
            class="rounded bg-red-900/60 px-3 py-1 text-red-200 hover:bg-red-900"
            onClick={() => {
              void props.store.cancel();
            }}
          >
            Stop
          </button>
        </Show>
      </div>

      <Combobox
        open={open()}
        anchor={ANCHOR}
        items={items()}
        activeIndex={navigation.activeIndex()}
        onActivate={navigation.setActiveIndex}
        onSelect={commit}
        emptyLabel={token()?.kind === "file" ? "no files" : "no commands"}
      />
    </div>
  );
}
