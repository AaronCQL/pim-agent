import { createEffect, createMemo, createSignal, Show } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { Format, type ContextFill } from "#core/shared/Format";
import type { ModelCatalogue, SessionStore } from "../session/SessionStore";
import { Combobox, createComboboxNavigation } from "../ui/Combobox";
import { createMediaQuery, KEYBOARD } from "../ui/media";
import { Menu } from "../ui/Menu";
import { Attachments, type AttachmentTile } from "../view/Attachments";
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
 * Whether an Enter is a send or a newline. Same rule on both platforms —
 * send is whatever the fingers present can actually reach — which reads as
 * two behaviours because the hardware differs: a modifier always sends, and
 * bare Enter sends only where Shift+Enter exists to type the newline
 * instead. A soft keyboard has no modifier at all, so there bare Enter is the
 * only way to reach a second line and the send button is the only send.
 */
function sends(event: KeyboardEvent, keyboard: boolean): boolean {
  if (event.ctrlKey || event.metaKey) {
    return true;
  }
  return keyboard && !event.shiftKey;
}

/**
 * A press that must not move focus. Neither button needs it, and a phone
 * charges for taking it: blurring the textarea retracts the soft keyboard,
 * which reflows the card down the screen before the tap becomes a click, so
 * the first tap is spent putting the keyboard away and the second is the one
 * that sends. `mousedown` is where the browser decides to focus, and touch
 * defers its compat `mousedown` to the end of the tap, so refusing the
 * default there covers both pointers.
 */
function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

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
  /**
   * A message taken back out of pi's queue elsewhere on the page — the
   * transcript's own card is the other way to reach it — to be edited here.
   * A new object each time, so recalling the same words twice is two events
   * and not one.
   */
  readonly recalled?: { readonly text: string };
}) {
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [items, setItems] = createSignal<readonly PickerItem[]>([]);
  // ESC closes the picker for *this* token only: remembering the dismissed key
  // rather than a boolean means the next keystroke, which moves the query,
  // re-opens it without a second gesture.
  const [dismissed, setDismissed] = createSignal("");
  const [failed, setFailed] = createSignal("");
  /**
   * Uploads still in flight, drawn from the browser's own copy of the bytes.
   * A photo is on screen the instant it is dropped rather than a round trip
   * later — the wait is the upload, and hiding it until it finishes makes a
   * dropped file look like a file that was refused.
   */
  const [uploading, setUploading] = createSignal<readonly AttachmentTile[]>([]);
  const [dropping, setDropping] = createSignal(false);
  const keyboard = createMediaQuery(KEYBOARD);
  const [catalogue, setCatalogue] = createSignal<ModelCatalogue>({
    models: [],
    thinkingLevels: [],
  });
  let input!: HTMLTextAreaElement;
  let chooser!: HTMLInputElement;
  // The picker is placed over the whole card, not the textarea: the card is
  // what the reader sees the completion belonging to.
  let card!: HTMLDivElement;
  let generation = 0;
  let previews = 0;

  /**
   * Every write to the message goes through here: the store mirrors it as
   * the session's draft, so a box that changed without telling it would lose
   * the message on the next switch and leave the sidebar naming a row after
   * one that is no longer typed.
   */
  function edit(next: string): void {
    setText(next);
    props.store.setDraftText(next);
  }

  const token = createMemo(() => activeToken(text(), caret()));
  const key = createMemo(() => tokenKey(token()));
  const open = createMemo(() => key() !== "" && dismissed() !== key());
  /**
   * What the row above the box shows: the session's uploaded files, each
   * removable, and after them whatever is still on its way up.
   */
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
      ...uploading(),
    ];
  });
  /**
   * The composer has one button, and this is which one it is. Stop only when
   * there is nothing to send — a turn running and an empty box — because a
   * message written into a running turn steers it, so anything typed or
   * attached is a send even mid-turn. Escape is the other way to stop, and
   * it does not wait for the box to be empty.
   */
  const stops = createMemo(
    () =>
      props.store.isBusy() && text().trim() === "" && attachments().length === 0
  );
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

  createEffect(
    () => props.recalled,
    (held) => {
      if (held) {
        reclaim(held.text);
      }
    }
  );

  /**
   * The box belongs to the session, not to the page: what is in it is the
   * draft of whichever session is attached, so a switch swaps it — and a
   * reload finds the unsent message where it was left rather than only in
   * the sidebar row it names. The textarea is uncontrolled, so the swap is
   * written into the element like every other write to it.
   *
   * Attachments swap with it and for the same reason: they were uploaded
   * against the session being left, and the server is still holding them
   * under it, so they are waiting where they were dropped when the reader
   * comes back. Only the uploads still in flight are dropped here — the tile
   * is this browser's preview of bytes that will land in the session they
   * were meant for either way.
   */
  createEffect(
    () => props.store.state.sessionId,
    (sessionId) => {
      const held = props.store.draftText(sessionId);
      setText(held);
      setCaret(held.length);
      setItems([]);
      setDismissed("");
      setUploading([]);
      input.value = held;
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

  /**
   * Every way bytes get in ends here — drop, paste, and the button. All of
   * them at once rather than one after another: a five-photo drop over a
   * home connection is five uploads, and doing them in turn makes the last
   * one wait for four it has nothing to do with.
   */
  async function absorb(files: readonly File[]): Promise<void> {
    setFailed("");
    await Promise.all(files.map((file) => hoist(file)));
  }

  async function hoist(file: File): Promise<void> {
    const key = `uploading:${++previews}`;
    const preview = URL.createObjectURL(file);
    setUploading((current) => [
      ...current,
      {
        key,
        name: file.name,
        url: preview,
        isImage: file.type.startsWith("image/"),
        uploading: true,
      },
    ]);
    try {
      await props.store.attachFile(file);
    } catch (err) {
      setFailed(`${file.name}: ${(err as Error).message}`);
    } finally {
      setUploading((current) => current.filter((one) => one.key !== key));
      URL.revokeObjectURL(preview);
    }
  }

  /**
   * Says the message. Into a running turn that is a steer, which is the
   * store's business and not the box's: from here it is the same send.
   */
  async function submit(): Promise<void> {
    const draft = text();
    if (draft.trim() === "" && attachments().length === 0) {
      return;
    }
    setText("");
    // Not `edit`: the store empties the session's draft itself when the
    // message is handed to it, and it is the store that decides what the row
    // is called from there on.
    setCaret(0);
    setItems([]);
    input.value = "";
    // Before the await, so the optimistic message the store appends is
    // already anchored by the time it paints.
    props.onSend();
    await props.store.prompt(draft);
  }

  /**
   * Stopping takes back whatever pi was still holding for the turn, which
   * belongs in the box it was typed into rather than on the floor — the TUI
   * restores it to its editor on the same gesture.
   */
  async function stop(): Promise<void> {
    reclaim(await props.store.cancel());
  }

  /**
   * Puts a message pi handed back into the box and takes focus, however it
   * was reclaimed — stopping the turn, or clicking its card. Joined the way
   * the queue itself joins, so what comes back reads exactly as the card
   * that was holding it, with anything typed meanwhile after it: where
   * sending would have put it.
   */
  function reclaim(restored: string): void {
    if (restored === "") {
      return;
    }
    const next = [restored, text()].filter((part) => part.trim()).join("\n\n");
    edit(next);
    setCaret(next.length);
    input.value = next;
    input.focus();
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
        <Attachments files={tiles()} compact />

        <textarea
          ref={(element: HTMLTextAreaElement) => {
            input = element;
          }}
          rows={1}
          placeholder="Type your message here"
          aria-label="Message"
          // A soft keyboard draws this key from the hint, and a Return that
          // is labelled "send" while it types a newline is a lie.
          enterkeyhint={keyboard() ? "send" : "enter"}
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
            // Nothing left to dismiss, so Escape means the turn — whatever
            // is in the box. What pi was holding for it comes back here.
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

        {/* Chips wrap rather than overflow, and their labels truncate: on a
            phone the model name is the first thing that would push the send
            button off the card. */}
        <div class="flex flex-wrap items-end gap-2">
          {/* Dropping and pasting were the only ways in, and neither is
              visible: a phone has no drag and a first-time reader has no
              reason to try. The input is the control — the button only
              reaches it — so the file dialogue is the platform's own. */}
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
              // Cleared so choosing the same file twice is two events; the
              // input keeps its value otherwise and the second pick is silent.
              chooser.value = "";
              void absorb(picked);
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            // Sized and coloured as a `Menu` chip with no label, because
            // that is what it is: one of the row's controls, not the send.
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

          {/* One button in one place, whatever the session is doing: a second
              circle beside it would be a destructive action a thumb's width
              from the one it is aiming at, and would move the target the
              moment a turn started. Steering is still sending, so it is still
              the send icon; only an empty box mid-turn turns it into stop. */}
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
