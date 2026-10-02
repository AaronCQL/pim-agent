import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";

import { Markdown } from "../markdown/Markdown";
import { ACTION, FIELD, QUIET } from "../ui/classes";
import { CopyButton } from "../ui/CopyButton";
import { Modal } from "../ui/Modal";
import type { SessionStore, UiAnswer, UiRequest } from "./SessionStore";

const UNNAMED = "Command";

function Ask(props: {
  readonly request: UiRequest;
  readonly onAnswer: (answer: UiAnswer) => void;
}) {
  const [value, setValue] = createSignal("");
  let box: HTMLInputElement | undefined;

  createEffect(
    () => props.request.requestId,
    () => {
      setValue("");
      if (untrack(() => props.request.method) === "input") {
        box?.focus();
      }
    }
  );

  const submit = (): void => {
    if (value().trim() !== "") {
      props.onAnswer({ value: value() });
    }
  };

  return (
    <div class="flex shrink-0 flex-col gap-2 border-t border-neutral-700 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div class="text-base leading-[--line]">
        <span class="font-bold">{props.request.title}</span>
        <Show when={props.request.message}>
          {(message) => (
            <p class="whitespace-pre-wrap text-neutral-400">{message()}</p>
          )}
        </Show>
      </div>
      <Switch>
        <Match when={props.request.method === "select"}>
          <div class="flex flex-wrap gap-2">
            <For each={props.request.options ?? []}>
              {(option) => (
                <button
                  type="button"
                  class={QUIET}
                  onClick={() => {
                    props.onAnswer({ value: option });
                  }}
                >
                  {option}
                </button>
              )}
            </For>
          </div>
        </Match>
        <Match when={props.request.method === "confirm"}>
          <div class="flex gap-2">
            <button
              type="button"
              class={ACTION}
              onClick={() => {
                props.onAnswer({ confirmed: true });
              }}
            >
              Yes
            </button>
            <button
              type="button"
              class={QUIET}
              onClick={() => {
                props.onAnswer({ confirmed: false });
              }}
            >
              No
            </button>
          </div>
        </Match>
        <Match when={props.request.method === "input"}>
          <div class="flex items-center gap-2">
            <input
              ref={(element: HTMLInputElement) => {
                box = element;
              }}
              type="text"
              value={value()}
              autofocus
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              aria-label={props.request.title}
              placeholder={props.request.placeholder ?? ""}
              class={FIELD}
              onInput={(event: InputEvent) => {
                setValue((event.currentTarget as HTMLInputElement).value);
              }}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <button
              type="button"
              class={ACTION}
              disabled={value().trim() === ""}
              onClick={submit}
            >
              Send
            </button>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

/** A command's notices, followed by its oldest open dialog. */
export function CommandModal(props: { readonly store: SessionStore }) {
  const notices = () => props.store.state.notices;
  const request = (): UiRequest | undefined => props.store.state.requests[0];
  const open = createMemo(
    (): boolean => notices().length > 0 || request() !== undefined
  );
  const title = createMemo(
    (): string => notices()[0]?.command ?? request()?.command ?? UNNAMED
  );

  return (
    <Modal
      open={open()}
      onClose={() => {
        props.store.closeCommand();
      }}
      label={title()}
      size="narrow"
      header={<div class="font-bold leading-[--line]">{title()}</div>}
    >
      <Show when={open()}>
        <div class="min-h-0 overflow-y-auto">
          <For each={notices()}>
            {(notice) => (
              <div class="flex items-start gap-2 border-b border-neutral-800 p-3 text-base leading-[--line] last:border-b-0">
                <div class="min-w-0 flex-1">
                  <Markdown text={notice.text} />
                </div>
                <CopyButton text={() => notice.text} label="Copy notice" />
              </div>
            )}
          </For>
        </div>
        <Show when={request()}>
          {(asked) => (
            <Ask
              request={asked()}
              onAnswer={(answer) => {
                props.store.answerRequest(asked().requestId, answer);
              }}
            />
          )}
        </Show>
      </Show>
    </Modal>
  );
}
