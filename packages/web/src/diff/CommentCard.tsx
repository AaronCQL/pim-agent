import { onSettled, Show, untrack } from "solid-js";

import { ICON } from "../ui/classes";
import type { Comment } from "./Comments";

function range(comment: Comment): string {
  if (comment.start === undefined || comment.end === undefined) {
    return "whole file";
  }
  return comment.start === comment.end
    ? `line ${comment.start}`
    : `lines ${comment.start}–${comment.end}`;
}

/** One comment, which is its own editor: every keystroke is written, and an empty one blurs away. */
export function CommentCard(props: {
  readonly comment: Comment;
  /** The file has changed since this was written; it still reads, and still sends. */
  readonly outdated: boolean;
  readonly focus: boolean;
  readonly onWrite: (text: string) => void;
  readonly onRemove: () => void;
}) {
  let box: HTMLTextAreaElement | undefined;

  onSettled(() => {
    if (untrack(() => props.focus)) {
      box?.focus();
    }
  });

  return (
    <div class="my-1 max-w-2xl rounded-lg bg-neutral-900 p-2 text-sm whitespace-normal">
      <div class="flex items-center gap-2">
        <span class="text-neutral-400 tabular-nums">
          {range(props.comment)}
        </span>
        <Show when={props.outdated}>
          <span class="text-amber-400">outdated</span>
        </Show>
        <button
          type="button"
          aria-label={`Delete the comment on ${props.comment.path}`}
          title="Delete this comment"
          class={`${ICON} ml-auto size-6`}
          onClick={() => {
            props.onRemove();
          }}
        >
          <span class="i-griddy-icons:close size-4" aria-hidden="true" />
        </button>
      </div>
      <textarea
        ref={(element: HTMLTextAreaElement) => {
          box = element;
        }}
        rows={2}
        aria-label={`Comment on ${props.comment.path}`}
        placeholder="What should change here?"
        value={props.comment.text}
        class="max-h-40 w-full resize-none rounded-lg bg-neutral-850 px-2 py-1.5 outline-none ring-1 ring-transparent [field-sizing:content] placeholder:text-neutral-500 focus:ring-neutral-600"
        onInput={(event) => {
          props.onWrite(event.currentTarget.value);
        }}
        onBlur={() => {
          if (untrack(() => props.comment.text).trim() === "") {
            props.onRemove();
          }
        }}
      />
    </div>
  );
}
