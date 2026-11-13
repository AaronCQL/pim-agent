import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  untrack,
} from "solid-js";

import { baseName } from "../format";
import type { SessionStore } from "../session/SessionStore";
import { CHIP_SEGMENT } from "../ui/classes";
import {
  Combobox,
  createComboboxNavigation,
  type ComboboxItem,
} from "../ui/Combobox";
import { createDisclosure } from "../ui/disclosure";
import { Fitted } from "../ui/Fitted";

const PANEL_WIDTH = 240;

export function RepoMenu(props: {
  readonly store: SessionStore;
  /** Repositories below the cwd, sorted; undefined until read. */
  readonly repos: readonly string[] | undefined;
  readonly onOpen: () => void;
  readonly class: string;
}) {
  const [switching, setSwitching] = createSignal<string>();
  const [failure, setFailure] = createSignal("");

  const state = (): SessionStore["state"] => props.store.state;
  const nameOf = (repo: string): string =>
    repo === "" ? baseName(state().cwd) : repo;
  const missing = (): boolean =>
    props.repos !== undefined &&
    state().repo !== "" &&
    !props.repos.includes(state().repo);

  const choices = createMemo<readonly string[]>(() => {
    const listed = props.repos ?? [];
    const repo = state().repo;
    return [
      "",
      ...listed,
      ...(repo !== "" && !listed.includes(repo) ? [repo] : []),
    ];
  });

  const describe = (repo: string): string | undefined => {
    if (repo === "") {
      return "working directory";
    }
    return repo === state().repo && missing() ? "not found" : undefined;
  };

  const rows = createMemo<readonly ComboboxItem[]>(() =>
    choices().map((repo) => {
      const description = describe(repo);
      return {
        label: nameOf(repo),
        selected: repo === state().repo,
        busy: repo === switching(),
        ...(description === undefined ? {} : { description }),
      };
    })
  );

  const choose = (index: number): void => {
    const repo = choices()[index];
    if (repo === undefined || switching() !== undefined) {
      return;
    }
    if (repo === state().repo) {
      panel.close();
      return;
    }
    setFailure("");
    setSwitching(repo);
    void props.store
      .setRepo(repo)
      .then(panel.close, (error: Error) => {
        setFailure(error.message);
      })
      .finally(() => {
        setSwitching(undefined);
      });
  };

  const panel = createDisclosure({
    onOpen: () => {
      setFailure("");
      navigation.setActiveIndex(untrack(() => choices().indexOf(state().repo)));
      props.onOpen();
    },
  });

  const navigation = createComboboxNavigation({
    count: () => choices().length,
    open: panel.open,
    onSelect: choose,
    onDismiss: panel.close,
  });

  createEffect(choices, (next, previous) => {
    const held = previous?.[untrack(navigation.activeIndex)];
    if (held !== undefined) {
      navigation.setActiveIndex(next.indexOf(held));
    }
  });

  return (
    <div ref={panel.root} class="flex min-w-0">
      <button
        ref={panel.trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={panel.open() ? "true" : "false"}
        aria-label={`Repository ${nameOf(state().repo)}, switch`}
        title={`Git actions run in ${nameOf(state().repo)}`}
        class={`${CHIP_SEGMENT} ${props.class}`}
        onClick={panel.toggle}
        onKeyDown={navigation.onKeyDown}
      >
        <span class="i-griddy-icons:folder-code size-4 shrink-0" />
        <Show when={state().repo}>
          {(repo) => <Fitted texts={[repo(), baseName(repo())]} />}
        </Show>
      </button>

      <Combobox
        open={panel.open()}
        anchor={panel.anchor}
        place="below"
        min={PANEL_WIDTH}
        items={rows()}
        activeIndex={navigation.activeIndex()}
        onActivate={navigation.setActiveIndex}
        onSelect={choose}
        header={
          <div class="mb-1 flex flex-col gap-1 px-2">
            <p class="text-xs text-neutral-500">Repository for git actions</p>
            <Show when={failure()}>
              {(message) => (
                <p
                  role="alert"
                  class="max-h-20 overflow-y-auto text-xs whitespace-pre-wrap text-rose-400"
                >
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
