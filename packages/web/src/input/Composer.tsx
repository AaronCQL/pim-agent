import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { Format, type ContextFill } from "#core/shared/Format";
import type {
  ModelCatalogue,
  SessionStore,
  UploadedAttachment,
} from "../session/SessionStore";
import { Combobox, createComboboxNavigation } from "../ui/Combobox";
import { Menu } from "../ui/Menu";
import { ClankChip } from "./ClankChip";
import { activeToken, applyCompletion, tokenKey } from "./token";

const FILE_LIMIT = 50;
const COMMAND_LIMIT = 20;

/** The ramp's colour for each verdict `Format.contextFill` hands back. */
const CONTEXT_TONES: Record<ContextFill, string> = {
  ok: "text-neutral-350",
  warn: "text-amber-400",
  full: "text-rose-400",
};

/**
 * The draft, the pickers over it, and the two ways bytes get in.
 *
 * Ranking never happens here: `@` names a file on the *agent's* disk and a
 * skill is a capability on the agent's disk, so both are one server query and
 * at most `limit` rows back. An upload is the opposite
 * direction and not a picker at all — the bytes are transferred into the
 * server's world first, and only the id the server answered with is ever
 * attached to a message.
 *
 * The card also carries what used to be the footer: a row of pills above it —
 * the clank reading on the left, spend and context fill on the right — the
 * model and thinking chips on its control row, and the last error as a rose
 * line above it. The mockup has no stop state, so the send button turns rose
 * and becomes Stop while a turn is running.
 */
export function Composer(props: {
  readonly store: SessionStore;
  /** Sending is a claim on the end of the transcript; the shell scrolls to it. */
  readonly onSend: () => void;
}) {
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
  const [catalogue, setCatalogue] = createSignal<ModelCatalogue>({
    models: [],
    thinkingLevels: [],
  });
  let input!: HTMLTextAreaElement;
  // The picker is placed over the whole card, not the textarea: the card is
  // what the reader sees the completion belonging to.
  let card!: HTMLDivElement;
  let generation = 0;

  const token = createMemo(() => activeToken(text(), caret()));
  const key = createMemo(() => tokenKey(token()));
  const open = createMemo(() => key() !== "" && dismissed() !== key());
  // One memo, not a percentage read three times: a fill of 0 is a reading,
  // and an object keeps it from being mistaken for "no reading yet".
  const fill = createMemo(() => {
    const percent = props.store.state.contextPercent;
    return percent === undefined
      ? undefined
      : {
          text: `${percent.toFixed(1)}%`,
          tone: CONTEXT_TONES[Format.contextFill(percent)],
        };
  });
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
    // Before the await, so the optimistic message the store appends is
    // already anchored by the time it paints.
    props.onSend();
    await props.store.prompt(draft, attached);
  }

  /**
   * Asked for when a chip is opened rather than on mount: the catalogue is a
   * property of the server, the store caches it for the connection, and a
   * session nobody ever switches models on should not pay for it.
   */
  function loadCatalogue(): void {
    void props.store.listModels().then(setCatalogue);
  }

  return (
    <div class="pointer-events-auto relative w-full max-w-3xl">
      {/* The pill row. The clank reading is the only one that changes width
          every second, so it sits at the left end where its digits push
          nothing around; `ml-auto` keeps spend and fill against the card's
          right edge whether or not it is drawn. */}
      <div class="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex items-center gap-2">
        <ClankChip store={props.store} />
        {/* The divided pill: spend on the left, context fill on the right,
            each half drawn only once there is something to say. */}
        <Show when={props.store.state.cost > 0 || fill() !== undefined}>
          <div class="ml-auto flex items-center divide-x-1.5 divide-neutral-750 rounded-lg bg-neutral-900 text-sm text-neutral-350 tabular-nums ring-1 ring-neutral-750">
            <Show when={props.store.state.cost > 0}>
              <div class="px-2.5 py-1">{`$${props.store.state.cost.toFixed(3)}`}</div>
            </Show>
            <Show when={fill()}>
              {(shown) => (
                <div class={`px-2.5 py-1 ${shown().tone}`}>
                  {shown().text}
                  <Show when={props.store.state.contextWindow}>
                    {(window) => (
                      <span class="text-neutral-500">
                        {`/${Format.formatTokens(window())}`}
                      </span>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>

      <Show when={props.store.state.error ?? failed()}>
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
          void absorb([...(event.dataTransfer?.files ?? [])]);
        }}
      >
        <Show when={attachments().length > 0}>
          <ul class="flex flex-wrap gap-1.5 text-sm">
            <For each={attachments()}>
              {(attachment) => (
                <li class="flex items-center gap-1 rounded-full bg-neutral-900 px-2.5 py-1 text-neutral-350">
                  <span
                    class={`size-4 shrink-0 ${attachment.isImage ? "i-griddy-icons:image" : "i-griddy-icons:attachment"}`}
                    aria-hidden="true"
                  />
                  <span class="max-w-40 truncate">{attachment.label}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.label}`}
                    class="i-griddy-icons:close size-4 hover:text-neutral-50"
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
          rows={1}
          placeholder="Type your message here"
          aria-label="Message"
          class="max-h-50 w-full resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-neutral-500"
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
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />

        {/* Chips wrap rather than overflow, and their labels truncate: on a
            phone the model name is the first thing that would push the send
            button off the card. */}
        <div class="flex flex-wrap items-end gap-2">
          <Show when={props.store.state.model}>
            {(model) => (
              <Menu
                label={props.store.state.modelLabel}
                title="Model"
                icon="i-griddy-icons:robot"
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

          <Show
            when={props.store.isBusy()}
            fallback={
              <button
                type="button"
                aria-label="Send"
                class="flex items-center justify-center rounded-full bg-indigo-500 p-2 text-indigo-50 ring-indigo-300 hover:ring-1 active:bg-indigo-500/80"
                onClick={() => {
                  void submit();
                }}
              >
                <span class="i-griddy-icons:send-alt-02-filled size-5" />
              </button>
            }
          >
            <button
              type="button"
              aria-label="Stop"
              class="flex items-center justify-center rounded-full bg-rose-500 p-2 text-rose-50 ring-rose-300 hover:ring-1 active:bg-rose-500/80"
              onClick={() => {
                void props.store.cancel();
              }}
            >
              <span class="i-griddy-icons:stop-filled size-5" />
            </button>
          </Show>
        </div>
      </div>

      <Combobox
        open={open()}
        anchor={() => card}
        items={items()}
        activeIndex={navigation.activeIndex()}
        onActivate={navigation.setActiveIndex}
        onSelect={commit}
        emptyLabel={token()?.kind === "file" ? "no files" : "no commands"}
      />
    </div>
  );
}
