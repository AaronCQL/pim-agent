import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";

import type { SessionSummaryView } from "#protocol/ServerEvent";
import { version } from "../../../../package.json";
import type { SessionStore } from "../session/SessionStore";
import { abbreviateHome, baseName, relativeTime } from "../format";
import { ICON } from "../ui/classes";
import { Spinner } from "../ui/Spinner";

type Row = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly listed: SessionSummaryView | undefined;
};

/** The session list, read straight off the server's sessions directory; `onNavigate` fires when a row is picked. */
export function Sidebar(props: {
  readonly store: SessionStore;
  readonly onNavigate?: () => void;
  readonly onOpenSettings?: () => void;
}) {
  const [sessions, setSessions] = createSignal<readonly SessionSummaryView[]>(
    []
  );
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => {
    setNow(Date.now());
  }, 1000);
  onCleanup(() => {
    clearInterval(clock);
  });

  createEffect(
    () => ({
      sessionId: props.store.state.sessionId,
      connection: props.store.state.connection,
      catalogue: props.store.state.catalogue,
      running: props.store.runningIds(),
    }),
    (state, before) => {
      const stale =
        before === undefined ||
        before.sessionId !== state.sessionId ||
        before.catalogue !== state.catalogue ||
        (state.connection === "open" && before.connection !== "open") ||
        before.running.some((sessionId) => !state.running.includes(sessionId));
      if (stale) {
        void props.store.listSessions().then(setSessions);
      }
    }
  );

  // `unwrittenSummary` answers with a new object on every keystroke; compare by value to keep typing out of `rows`.
  const held = createMemo(() => props.store.unwrittenSummary(), {
    equals: (before, after) =>
      before?.sessionId === after?.sessionId && before?.cwd === after?.cwd,
  });

  const rows = createMemo<readonly Row[]>(() => {
    const listed = sessions().map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      listed: session,
    }));
    const unwritten = held();
    if (
      !unwritten ||
      listed.some((row) => row.sessionId === unwritten.sessionId)
    ) {
      return listed;
    }
    return [{ ...unwritten, listed: undefined }, ...listed];
  });

  const title = (row: Row): string =>
    row.listed?.title ??
    props.store.localTitle(row.sessionId) ??
    row.sessionId.slice(0, 8);

  const go = (run: () => Promise<void>): void => {
    props.onNavigate?.();
    void run().catch(() => undefined);
  };

  const age = (row: Row): string | undefined =>
    row.listed === undefined
      ? undefined
      : relativeTime(row.listed.settledAt, now());

  return (
    <div class="flex h-full flex-col bg-neutral-950">
      <div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-neutral-700 px-3">
        <div class="flex items-center gap-2">
          <h1 class="shrink-0">
            <img src="/wordmark.svg" alt="PIM" class="block h-5" />
          </h1>
          <span
            class="rounded-full bg-neutral-850 px-2 py-0.5 text-xs text-neutral-350"
            title={
              props.store.state.piVersion
                ? `pi ${props.store.state.piVersion}`
                : undefined
            }
          >
            {`v${props.store.state.pimVersion ?? version}`}
          </span>
        </div>
        <div class="flex shrink-0 items-center">
          <button
            type="button"
            aria-label="New session"
            title="New session"
            class={ICON}
            onClick={() => {
              go(() => props.store.newSession());
            }}
          >
            <span class="i-griddy-icons:chat-bubble-plus size-5" />
          </button>
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            class={ICON}
            onClick={() => props.onOpenSettings?.()}
          >
            <span class="i-griddy-icons:settings size-5" />
          </button>
        </div>
      </div>

      <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        <Show
          when={rows().length > 0}
          fallback={<li class="text-sm text-neutral-500">No sessions yet.</li>}
        >
          {/* Keyed: a listing answers with fresh objects, and an unkeyed `<For>` remounts every row. */}
          <For each={rows()} keyed={(row: Row) => row.sessionId}>
            {(row) => (
              <li>
                <button
                  type="button"
                  class={{
                    "w-full space-y-1 rounded-lg px-3 py-2 text-left text-sm": true,
                    "bg-neutral-850":
                      row().sessionId === props.store.state.sessionId,
                    "text-neutral-300 hover:bg-neutral-900":
                      row().sessionId !== props.store.state.sessionId,
                  }}
                  onClick={() => {
                    go(() => props.store.switchTo(row().sessionId));
                  }}
                >
                  <div class="flex items-center justify-between gap-2">
                    <div class="truncate font-semibold">{title(row())}</div>
                    <Show when={props.store.isUnread(row().sessionId)}>
                      <div
                        class="size-1.5 shrink-0 rounded-full bg-indigo-400"
                        aria-label="Unread"
                      />
                    </Show>
                  </div>
                  <div class="flex items-center justify-between gap-6 text-neutral-400">
                    <div class="truncate" title={abbreviateHome(row().cwd)}>
                      {baseName(row().cwd)}
                    </div>
                    <div class="flex shrink-0 items-center gap-1.5">
                      <Show
                        when={props.store.draftText(row().sessionId) !== ""}
                      >
                        <span
                          class="i-griddy-icons:edit size-3 text-amber-400"
                          aria-label="Unsent draft"
                          title="Unsent draft"
                        />
                      </Show>
                      <Switch>
                        <Match when={props.store.isRunning(row().sessionId)}>
                          <Spinner />
                        </Match>
                        <Match when={age(row())}>
                          {(shown) => <span>{shown()}</span>}
                        </Match>
                      </Switch>
                    </div>
                  </div>
                </button>
              </li>
            )}
          </For>
        </Show>
      </ul>
    </div>
  );
}
