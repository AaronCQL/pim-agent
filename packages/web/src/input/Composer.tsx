import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  untrack,
} from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { activeToken, applyCompletion, tokenKey } from "#core/picker/token";
import type { ModelCatalogue, SessionStore } from "../session/SessionStore";
import { Combobox, createComboboxNavigation } from "../ui/Combobox";
import { createMediaQuery, KEYBOARD } from "../ui/media";
import { Menu } from "../ui/Menu";
import { Attachments, type AttachmentTile } from "../view/Attachments";
import { ClankChip } from "./ClankChip";
import { Readouts } from "./Readouts";
import { createUploads } from "./uploads";

function sends(event: KeyboardEvent, keyboard: boolean): boolean {
  if (event.ctrlKey || event.metaKey) {
    return true;
  }
  return keyboard && !event.shiftKey;
}

// Refuse focus on `mousedown`: blurring the textarea retracts the soft keyboard and reflows the card before the tap becomes a click.
function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

/** The draft, the pickers over it, and the two ways bytes get in. */
export function Composer(props: {
  readonly store: SessionStore;
  readonly onSend: () => void;
  /** A message taken back out of pi's queue to be edited here; a new object each time. */
  readonly recalled?: { readonly text: string };
}) {
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [items, setItems] = createSignal<readonly PickerItem[]>([]);
  const [dismissed, setDismissed] = createSignal("");
  const [dropping, setDropping] = createSignal(false);
  const uploads = createUploads(props.store);
  const keyboard = createMediaQuery(KEYBOARD);
  const [catalogue, setCatalogue] = createSignal<ModelCatalogue>({
    models: [],
    thinkingLevels: [],
  });
  let input!: HTMLTextAreaElement;
  let chooser!: HTMLInputElement;
  let card!: HTMLDivElement;
  let generation = 0;

  // Every user write to the box goes through here: a bare `setText` leaves the store's draft stale and loses the message on the next session switch.
  function edit(next: string): void {
    setText(next);
    props.store.setDraftText(next);
  }

  const token = createMemo(() => activeToken(text(), caret()));
  const key = createMemo(() => tokenKey(token()));
  const open = createMemo(() => key() !== "" && dismissed() !== key());
  const attachments = createMemo(() =>
    props.store.attachmentsOf(props.store.state.sessionId)
  );
  const tiles = createMemo<readonly AttachmentTile[]>(() => {
    const sessionId = props.store.state.sessionId;
    return [
      ...attachments().map((file) => ({
        key: file.id,
        name: file.name,
        url: file.url,
        isImage: file.isImage,
        onRemove: () => {
          props.store.detachFile(sessionId, file.id);
        },
      })),
      ...uploads.tiles(),
    ];
  });
  const stops = createMemo(
    () =>
      props.store.isBusy() && text().trim() === "" && attachments().length === 0
  );
  const modelOptions = createMemo(() =>
    catalogue().models.map(({ id, label, provider }) => ({
      value: id,
      label,
      tag: provider,
    }))
  );
  const levelOptions = createMemo(() =>
    catalogue().thinkingLevels.map((level) => ({ value: level, label: level }))
  );

  createEffect(
    () => key(),
    () => {
      void refine();
    }
  );

  createEffect(
    () => props.recalled,
    (held) => {
      if (held) {
        reclaim(held.text);
      }
    }
  );

  createEffect(
    () => props.store.state.sessionId,
    (sessionId) => {
      // Snapshot, not a subscription: the draft belongs to the session being switched to.
      const held = untrack(() => props.store.draftText(sessionId));
      setText(held);
      setCaret(held.length);
      setItems([]);
      setDismissed("");
      uploads.reset();
      input.value = held;
    }
  );

  async function refine(): Promise<void> {
    const mine = ++generation;
    const active = untrack(token);
    if (!active) {
      setItems([]);
      return;
    }
    const rows =
      active.kind === "file"
        ? ((await props.store.files.rank(active.query, {})) ?? [])
        : await props.store.pickCommands(active.query);
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
    edit(completion.text);
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
    edit(input.value);
    setCaret(input.selectionStart ?? input.value.length);
  }

  async function submit(): Promise<void> {
    const draft = text();
    if (draft.trim() === "" && attachments().length === 0) {
      return;
    }
    setText("");
    setCaret(0);
    setItems([]);
    input.value = "";
    // Before the await, so the optimistic message the store appends is anchored by the time it paints.
    props.onSend();
    await props.store.prompt(draft);
  }

  async function stop(): Promise<void> {
    reclaim(await props.store.cancel());
  }

  function reclaim(restored: string): void {
    if (restored === "") {
      return;
    }
    const next = [restored, untrack(text)]
      .filter((part) => part.trim())
      .join("\n\n");
    edit(next);
    setCaret(next.length);
    input.value = next;
    input.focus();
  }

  function loadCatalogue(): void {
    void props.store.listModels().then(setCatalogue);
  }

  return (
    <div class="pointer-events-auto relative w-full max-w-3xl">
      <div class="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex items-center gap-2">
        <ClankChip store={props.store} />
        <Readouts store={props.store} />
      </div>

      <Show when={props.store.state.error ?? uploads.failed()}>
        {(message) => (
          <p class="mb-2 truncate text-sm text-rose-400">{message()}</p>
        )}
      </Show>

      <div
        ref={(element: HTMLDivElement) => {
          card = element;
        }}
        class={{
          "relative space-y-3 rounded-lg bg-neutral-850 p-4 ring-1": true,
          "ring-neutral-700": !dropping(),
          "ring-indigo-400": dropping(),
        }}
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
          void uploads.absorb([...(event.dataTransfer?.files ?? [])]);
        }}
      >
        <Attachments files={tiles()} variant="compact" />

        <textarea
          ref={(element: HTMLTextAreaElement) => {
            input = element;
          }}
          rows={1}
          placeholder="Type your message here"
          aria-label="Message"
          enterkeyhint={keyboard() ? "send" : "enter"}
          class="max-h-50 w-full resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-neutral-500"
          onInput={track}
          onClick={track}
          onKeyUp={track}
          onPaste={(event: ClipboardEvent) => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length > 0) {
              event.preventDefault();
              void uploads.absorb(files);
            }
          }}
          onKeyDown={(event: KeyboardEvent) => {
            if (navigation.onKeyDown(event)) {
              return;
            }
            if (event.key === "Tab" && event.shiftKey) {
              event.preventDefault();
              void props.store.cycleThinking();
              return;
            }
            if (event.key === "Escape" && props.store.isBusy()) {
              event.preventDefault();
              void stop();
              return;
            }
            if (
              event.key === "Enter" &&
              !event.isComposing &&
              sends(event, keyboard())
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />

        <div class="flex flex-wrap items-end gap-2">
          <input
            ref={(element: HTMLInputElement) => {
              chooser = element;
            }}
            type="file"
            multiple
            class="hidden"
            aria-hidden="true"
            tabindex={-1}
            onChange={(event: Event) => {
              const picked = [
                ...((event.target as HTMLInputElement).files ?? []),
              ];
              // Clear it, or choosing the same file twice fires no second event.
              chooser.value = "";
              void uploads.absorb(picked);
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            class="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-neutral-350 ring-neutral-600 hover:text-neutral-100 hover:ring-1"
            onMouseDown={keepFocus}
            onClick={() => {
              chooser.click();
            }}
          >
            <span class="i-griddy-icons:attachment size-4" aria-hidden="true" />
          </button>
          <Show when={props.store.state.model}>
            {(model) => (
              <Menu
                label={props.store.state.modelLabel}
                title="Model"
                icon="i-griddy-icons:robot"
                search="Search models"
                value={model()}
                options={modelOptions()}
                onOpen={loadCatalogue}
                onSelect={(id) => {
                  void props.store.setModel(id);
                }}
              />
            )}
          </Show>
          <Show when={props.store.state.thinking}>
            {(thinking) => (
              <Menu
                label={thinking()}
                title="Thinking"
                icon="i-griddy-icons:lightbulb-on"
                value={thinking()}
                options={levelOptions()}
                onOpen={loadCatalogue}
                onSelect={(level) => {
                  void props.store.setThinking(level);
                }}
              />
            )}
          </Show>

          <div class="flex-1" />

          <button
            type="button"
            aria-label={
              stops() ? "Stop" : props.store.isBusy() ? "Steer" : "Send"
            }
            class={`flex items-center justify-center rounded-full p-2 hover:ring-1 ${
              stops()
                ? "bg-rose-500 text-rose-50 ring-rose-300 active:bg-rose-500/80"
                : "bg-indigo-500 text-indigo-50 ring-indigo-300 active:bg-indigo-500/80"
            }`}
            onMouseDown={keepFocus}
            onClick={() => {
              if (stops()) {
                void stop();
                return;
              }
              void submit();
            }}
          >
            <span
              class={`size-5 ${
                stops()
                  ? "i-griddy-icons:stop-filled"
                  : "i-griddy-icons:send-alt-02-filled"
              }`}
            />
          </button>
        </div>
      </div>

      <Combobox
        open={open()}
        anchor={() => card}
        match
        items={items()}
        activeIndex={navigation.activeIndex()}
        onActivate={navigation.setActiveIndex}
        onSelect={commit}
        emptyLabel={token()?.kind === "file" ? "no files" : "no commands"}
      />
    </div>
  );
}
