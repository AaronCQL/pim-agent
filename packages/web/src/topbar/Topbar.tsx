import { createSignal, Show } from "solid-js";

import { abbreviateHome, baseName, splitTail } from "../format";
import type { SessionStore } from "../session/SessionStore";
import { DirectoryModal } from "./DirectoryModal";

/**
 * Half the row is every chip's ceiling, which is what makes a tight row
 * divide fairly between the two of them: a chip under its half is never
 * touched, so the long one gives up pixels until it is level with the short
 * one rather than both being trimmed together. Flex shrink alone divides an
 * overflow *in proportion to width*, which squeezes a chip that would have
 * fit whole. Shrink stays on underneath as the floor: when both chips are at
 * their ceiling and the row is narrower still, they are equal by then, so
 * proportional and fair are the same thing.
 */
const CHIP =
  "flex h-8 min-w-0 max-w-[50%] items-center gap-1.5 rounded-lg bg-neutral-850 px-2 text-sm text-neutral-350";

/**
 * The row above the transcript: where the session is, and what its repository
 * is doing. Two chips rather than one, because they are different facts on
 * different clocks — the cwd moves only when something moves it, the git
 * reading is polled.
 *
 * Neither chip is given a width: both size to their own text, and give it up
 * only when the row runs out.
 *
 * The directory is the row's one control, and the only entrance to choosing
 * one: where the session works is the single fact up here that a reader can
 * change, so it is a button and the branch beside it stays a readout — what
 * git says is not settable by asking.
 */
export function Topbar(props: {
  readonly store: SessionStore;
  /** Phone-width, where only the chips' leading facts survive. */
  readonly compact: boolean;
  readonly onToggleSidebar: () => void;
}) {
  const [choosing, setChoosing] = createSignal(false);
  // A phone gets the directory alone. The route to it is the first thing a
  // narrow row cannot afford and the last thing the reader needs there: the
  // question on a phone is which project this is, not where it sits on disk.
  const path = (cwd: string): string =>
    props.compact ? baseName(cwd) : abbreviateHome(cwd);

  return (
    <div class="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-700 px-3">
      <button
        type="button"
        aria-label="Toggle sessions"
        class="flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50"
        onClick={props.onToggleSidebar}
      >
        <span class="i-griddy-icons:sidebar size-5" />
      </button>

      <Show when={props.store.state.cwd}>
        {(cwd) => (
          <button
            type="button"
            class={`${CHIP} hover:bg-neutral-800 hover:text-neutral-50`}
            aria-label={`Working directory ${path(cwd())}, open another`}
            title={cwd()}
            onClick={() => {
              setChoosing(true);
            }}
          >
            <span class="i-griddy-icons:folder size-4 shrink-0" />
            <Elided text={path(cwd())} />
          </button>
        )}
      </Show>

      {/* Holds the branch chip against the right edge while there is room,
          and collapses to nothing before either chip is asked to shrink. */}
      <div class="flex-1" />

      {/* Nothing to draw outside a git repository. */}
      <Show when={props.store.state.branch}>
        {(branch) => (
          <div class={CHIP} title={branch()}>
            <span class="i-griddy-icons:code-branch size-4 shrink-0" />
            <Elided text={branch()} />
            <Show when={props.store.state.dirtyCount > 0}>
              <span
                class="shrink-0 text-amber-400"
                title={`${props.store.state.dirtyCount} changed files`}
              >
                ●{props.store.state.dirtyCount}
              </span>
            </Show>
            {/* Divergence is the first thing to go when the row is tight:
                it is the only fact here that is not about right now. */}
            <Show when={!props.compact}>
              <Show when={props.store.state.ahead > 0}>
                <span class="shrink-0" title="Commits to push">
                  ↑{props.store.state.ahead}
                </span>
              </Show>
              <Show when={props.store.state.behind > 0}>
                <span class="shrink-0 text-rose-400" title="Commits to pull">
                  ↓{props.store.state.behind}
                </span>
              </Show>
            </Show>
          </div>
        )}
      </Show>

      {/* Last, because it is not part of the row: an open dialog is in the
          top layer and a closed one is not drawn at all. */}
      <DirectoryModal
        open={choosing()}
        store={props.store}
        onClose={() => {
          setChoosing(false);
        }}
      />
    </div>
  );
}

/**
 * Text that loses its middle, and only as much of it as it has to: the head
 * shrinks under an ellipsis, the tail never does.
 */
function Elided(props: { readonly text: string }) {
  const parts = (): readonly [string, string] => splitTail(props.text);
  return (
    <span class="flex min-w-0">
      <span class="truncate">{parts()[0]}</span>
      <span class="shrink-0">{parts()[1]}</span>
    </span>
  );
}
