import { createSignal, Show, untrack } from "solid-js";

import { ACTION } from "../ui/classes";
import { CommitModal } from "./CommitModal";
import type { DiffStore } from "./DiffStore";
import { Stat } from "./Stat";

export function CommitActions(props: { readonly diff: DiffStore }) {
  const [writing, setWriting] = createSignal(false);

  const commit = (paths: readonly string[]): void => {
    void props.diff.commit(paths).then(() => {
      if (untrack(() => props.diff.state.failure) === undefined) {
        setWriting(false);
      }
    });
  };

  return (
    <>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <Stat
          added={props.diff.state.added}
          removed={props.diff.state.removed}
        />
        <Show when={props.diff.files().length > 0}>
          <button
            type="button"
            class={ACTION}
            title="Write a commit from these changes"
            onClick={() => {
              props.diff.forgetCommit();
              setWriting(true);
            }}
          >
            Commit
          </button>
        </Show>
      </div>
      <CommitModal
        open={writing()}
        target={props.diff.target()}
        files={props.diff.files()}
        message={props.diff.state.message}
        committing={props.diff.state.committing}
        failure={props.diff.state.failure}
        onClose={() => {
          setWriting(false);
        }}
        onMessage={(message) => {
          props.diff.setMessage(message);
        }}
        onCommit={commit}
      />
    </>
  );
}
