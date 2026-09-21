import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { ExtensionEntry, ExtensionGroup } from "#core/shared/PiExtensions";
import type { SessionStore } from "../session/SessionStore";
import { Check } from "../ui/Check";
import { QUIET } from "../ui/classes";
import { Spinner } from "../ui/Spinner";

/** Only the groups a reader has to be told apart by name; pim's own need none. */
const TITLES: Partial<Record<ExtensionGroup, string>> = {
  user: "Installed",
  project: "Project",
};

/**
 * The extensions this install loads, switched here and read back from the
 * server: a switch in another window arrives as `extensions_changed`, which
 * drops the roster this one is drawn from. Mounted only while the pane is
 * open, so opening it is what asks.
 */
export function Extensions(props: { readonly store: SessionStore }) {
  const [rows, setRows] = createSignal<readonly ExtensionEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const [pending, setPending] = createSignal<readonly string[]>([]);

  const load = (): void => {
    setLoading(true);
    setFailure("");
    void props.store
      .listExtensions()
      .then(
        (found) => {
          setRows(found);
        },
        (error: Error) => {
          setFailure(error.message);
        }
      )
      .finally(() => {
        setLoading(false);
      });
  };

  createEffect(
    () => props.store.state.extensions,
    () => {
      load();
    }
  );

  const paint = (id: string, enabled: boolean): void => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, enabled } : row))
    );
  };

  // Folded in the order the roster arrives in, so the server stays the only
  // place the groups are ordered and one it adds is drawn, not dropped.
  const shown = createMemo(() => {
    const groups = new Map<ExtensionGroup, ExtensionEntry[]>();
    for (const entry of rows()) {
      const found = groups.get(entry.group);
      if (found === undefined) {
        groups.set(entry.group, [entry]);
      } else {
        found.push(entry);
      }
    }
    return [...groups].map(([group, entries]) => ({
      title: TITLES[group],
      entries,
    }));
  });

  const toggle = (entry: ExtensionEntry, value: boolean): void => {
    setFailure("");
    paint(entry.id, value);
    setPending((current) => [...current, entry.id]);
    void props.store
      .setExtension(entry.id, value)
      .catch((error: Error) => {
        paint(entry.id, entry.enabled);
        setFailure(error.message);
      })
      .finally(() => {
        setPending((current) => current.filter((id) => id !== entry.id));
      });
  };

  return (
    <>
      <Show when={loading() && rows().length === 0}>
        <p class="flex items-center gap-2 text-sm text-neutral-500">
          <Spinner />
          Reading the extensions…
        </p>
      </Show>
      <Show when={failure()}>
        {(message) => (
          <div class="flex items-start gap-2">
            <p class="min-w-0 flex-1 text-sm text-rose-400">{message()}</p>
            <button type="button" class={QUIET} onClick={load}>
              Try again
            </button>
          </div>
        )}
      </Show>
      <For each={shown()}>
        {(section) => (
          <div class="space-y-2">
            <Show when={section.title}>
              {(title) => <h3 class="text-sm text-neutral-350">{title()}</h3>}
            </Show>
            <For each={section.entries}>
              {(entry) => (
                <Extension
                  entry={entry}
                  busy={pending().includes(entry.id)}
                  onChange={(value) => {
                    toggle(entry, value);
                  }}
                />
              )}
            </For>
          </div>
        )}
      </For>
      <Show when={!loading() && failure() === "" && rows().length === 0}>
        <p class="text-sm text-neutral-500">No extensions are installed.</p>
      </Show>
    </>
  );
}

function Extension(props: {
  readonly entry: ExtensionEntry;
  readonly busy: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  const locked = (): boolean => !props.entry.writable;

  return (
    <label class={`flex items-start gap-2 ${locked() ? "" : "cursor-pointer"}`}>
      <span class="flex h-[--line] shrink-0 items-center">
        <Check
          checked={props.entry.enabled}
          disabled={props.busy || locked()}
          label={props.entry.label}
          onChange={props.onChange}
        />
      </span>
      <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
        <span class="min-w-0 truncate">{props.entry.label}</span>
        <Show when={locked()}>
          <span class="shrink-0 rounded-full bg-neutral-850 px-1.5 text-xs text-neutral-350">
            Project — read-only here
          </span>
        </Show>
      </span>
    </label>
  );
}
