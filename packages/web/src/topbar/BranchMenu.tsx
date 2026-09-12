import { createMemo, createSignal, onCleanup, Show } from "solid-js";

import type { GitBranch } from "#core/shared/Git";
import { relativeTime } from "../format";
import type { SessionStore } from "../session/SessionStore";
import { CHIP_BUTTON, PILL } from "../ui/classes";
import {
  Combobox,
  createComboboxNavigation,
  type ComboboxItem,
} from "../ui/Combobox";
import { createDisclosure } from "../ui/disclosure";
import { Fitted } from "../ui/Fitted";
import { Spinner } from "../ui/Spinner";

// Not the footer's U+F069: that is a Nerd Font glyph, and no browser has the font.
const DIRTY_MARK = "*";

const SYNC = `${PILL} h-7 flex-1 px-3 text-sm disabled:text-neutral-600 disabled:hover:text-neutral-600 disabled:hover:ring-0`;

/** How far back a branch's last commit may be before it stops being live work. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Branch names are long and the chip is short; 300px still clears the narrowest phone. */
const PANEL_WIDTH = 300;

/** Said by the standing banner, and again by a press that the freeze answered. */
const BUSY = "Git operations are disabled as an agent is still working.";

type Operation = "checkout" | "pull" | "push";

type Row = ComboboxItem & { readonly branch: GitBranch };

function note(branch: GitBranch): string | undefined {
  if (branch.worktree) {
    return "in another worktree";
  }
  if (branch.gone) {
    return "upstream gone";
  }
  return branch.merged && !branch.isDefault ? "merged" : undefined;
}

function tag(branch: GitBranch, now: number): string {
  const parts = [relativeTime(branch.updatedAt * 1000, now)];
  if (branch.ahead > 0) {
    parts.push(`↑${branch.ahead}`);
  }
  if (branch.behind > 0) {
    parts.push(`↓${branch.behind}`);
  }
  return parts.join(" ");
}

function rowOf(branch: GitBranch, now: number): Row {
  const description = note(branch);
  return {
    branch,
    label: branch.name,
    tag: tag(branch, now),
    selected: branch.current,
    ...(description === undefined ? {} : { description }),
  };
}

/** Where the session stands and where the trunk is always belong on the list; the rest have to be live work. */
function live(branch: GitBranch, now: number): boolean {
  return (
    branch.current ||
    branch.isDefault ||
    (now - branch.updatedAt * 1000 <= WINDOW_MS &&
      !(branch.merged || branch.gone || branch.worktree))
  );
}

/** The repository chip: where the work is, and the two directions it can move. */
export function BranchMenu(props: {
  readonly store: SessionStore;
  readonly branch: string;
  readonly compact: boolean;
  readonly onOpenDiff: () => void;
}) {
  const [branches, setBranches] = createSignal<readonly GitBranch[]>([]);
  const [running, setRunning] = createSignal<Operation>();
  const [failure, setFailure] = createSignal("");

  const state = (): SessionStore["state"] => props.store.state;
  const frozen = (): boolean => state().repoBusy || running() !== undefined;

  const wake = (): void => {
    if (document.visibilityState === "visible") {
      void props.store.refreshGit();
    }
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
  });

  const load = (): Promise<void> =>
    props.store.listBranches().then(
      (found) => {
        setBranches(found);
      },
      (error: Error) => {
        setFailure(error.message);
      }
    );

  const shown = createMemo<readonly Row[]>(() => {
    const now = Date.now();
    return branches()
      .filter((branch) => live(branch, now))
      .map((branch) => rowOf(branch, now));
  });

  const attempt = (operation: Operation, run: () => Promise<void>): void => {
    setFailure("");
    setRunning(operation);
    void run()
      .then(
        () => {
          if (operation === "checkout") {
            panel.close();
            return;
          }
          void load();
        },
        (error: Error) => {
          setFailure(error.message);
        }
      )
      .finally(() => {
        setRunning(undefined);
      });
  };

  const choose = (index: number): void => {
    const row = shown()[index];
    if (!row) {
      return;
    }
    if (row.branch.current) {
      panel.close();
      return;
    }
    if (frozen()) {
      setFailure(
        state().repoBusy ? BUSY : "Another git operation is still running."
      );
      return;
    }
    attempt("checkout", () => props.store.checkout(row.branch.name));
  };

  const panel = createDisclosure({
    onOpen: () => {
      setFailure("");
      navigation.setActiveIndex(0);
      void load();
      // The counts only mean anything once the remote has been asked; the list paints before that lands.
      void props.store.refreshGit(true).then(load);
    },
  });

  const navigation = createComboboxNavigation({
    count: () => shown().length,
    open: panel.open,
    onSelect: choose,
    onDismiss: panel.close,
  });

  const Sync = (sync: {
    readonly operation: "pull" | "push";
    readonly icon: string;
    readonly label: string;
    readonly title: string;
    readonly disabled: boolean;
  }) => (
    <button
      type="button"
      class={SYNC}
      disabled={sync.disabled}
      title={sync.title}
      onClick={() => {
        attempt(sync.operation, () =>
          sync.operation === "pull" ? props.store.pull() : props.store.push()
        );
      }}
    >
      <Show
        when={running() === sync.operation}
        fallback={<span class={`${sync.icon} size-4 shrink-0`} />}
      >
        <Spinner />
      </Show>
      {sync.label}
    </button>
  );

  return (
    <div ref={panel.root} class="relative min-w-0">
      <button
        ref={panel.trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={panel.open() ? "true" : "false"}
        aria-label={`Branch ${props.branch}, switch or sync`}
        title={props.branch}
        class={CHIP_BUTTON}
        onClick={panel.toggle}
        onKeyDown={(event: KeyboardEvent) => {
          navigation.onKeyDown(event);
        }}
      >
        <span class="i-griddy-icons:code-branch size-4 shrink-0" />
        <Fitted texts={[props.branch]} />
        <Show when={state().dirtyCount > 0}>
          <span
            class="shrink-0 text-amber-400"
            title={`${state().dirtyCount} changed files`}
          >
            {DIRTY_MARK}
            {state().dirtyCount}
          </span>
        </Show>
        <Show
          when={!props.compact && (state().ahead > 0 || state().behind > 0)}
        >
          <span class="flex shrink-0 items-center">
            <Show when={state().ahead > 0}>
              <span title="Commits to push">↑{state().ahead}</span>
            </Show>
            <Show when={state().behind > 0}>
              <span class="text-rose-400" title="Commits to pull">
                ↓{state().behind}
              </span>
            </Show>
          </span>
        </Show>
      </button>

      <Combobox
        open={panel.open()}
        anchor={panel.anchor}
        place="below"
        min={PANEL_WIDTH}
        items={shown()}
        activeIndex={navigation.activeIndex()}
        onActivate={navigation.setActiveIndex}
        onSelect={choose}
        emptyLabel="no branches touched in the last 30 days"
        header={
          <div class="mb-1 flex flex-col gap-1">
            <div class="flex items-center gap-1">
              <Sync
                operation="pull"
                icon="i-griddy-icons:arrow-down"
                label="Pull"
                title="Fast-forward from the remote"
                disabled={frozen()}
              />
              <Sync
                operation="push"
                icon="i-griddy-icons:arrow-up"
                label="Push"
                title="Publish this branch"
                disabled={running() !== undefined}
              />
              <button
                type="button"
                class={SYNC}
                title="Read what has changed"
                onClick={() => {
                  panel.close();
                  props.onOpenDiff();
                }}
              >
                <span class="i-griddy-icons:code-compare size-4 shrink-0" />
                Diff
              </button>
            </div>

            <Show when={state().repoBusy}>
              <p class="px-2 text-xs text-amber-400">{BUSY}</p>
            </Show>
            <Show when={failure()}>
              {(message) => (
                <p class="max-h-20 overflow-y-auto px-2 text-xs whitespace-pre-wrap text-rose-400">
                  {message()}
                </p>
              )}
            </Show>
          </div>
        }
      />
    </div>
  );
}
