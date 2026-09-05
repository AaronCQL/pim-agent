import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";

import type { SessionSummaryView } from "#protocol/ServerEvent";
// The one place the distribution's own version reaches the browser. Vite and
// Bun both inline the field; nothing else from the manifest is bundled.
import { version } from "../../../../package.json";
import type { SessionStore } from "../session/SessionStore";
import type { ConnectionStatus } from "../ws/WsClient";
import { abbreviateHome, relativeTime } from "../format";

const CONNECTION_CLASSES: Record<ConnectionStatus, string> = {
  connecting: "text-amber-400",
  open: "text-emerald-400",
  reconnecting: "text-amber-400",
  closed: "text-rose-400",
};

/**
 * The session list, read straight off the server's sessions directory: there
 * is no index and no metadata store on either side, so a session the TUI
 * started shows up here with no synchronisation at all.
 *
 * Switching re-attaches the existing socket at `fromSeq: 0`; the connection
 * outlives the session it points at, and every session outlives every
 * connection to it.
 *
 * One component, two hosts — the layout renders it in place at `md:` and the
 * drawer renders it below that — so `onNavigate` is how the shell hears that a
 * row was picked: both hosts scroll the transcript to the end, and the drawer
 * also closes itself. A drawer left open over the session you just picked is
 * the classic bug.
 *
 * Flat and most-recent-first, per the mockup: the cwd is on every row, which
 * is what the old grouping by directory was for.
 */
export function Sidebar(props: {
  readonly store: SessionStore;
  readonly onNavigate?: () => void;
}) {
  const [sessions, setSessions] = createSignal<readonly SessionSummaryView[]>(
    []
  );
  // "23m" is a statement about now, not about the row, so it has to be re-read
  // on a clock rather than on whatever next re-renders the list.
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => {
    setNow(Date.now());
  }, 1000);
  onCleanup(() => {
    clearInterval(clock);
  });

  // Re-read on attach, on a switch, and when a turn *finishes*: a session only
  // appears on disk once it has content, and its modified time — the sort key
  // of this list — moves each time the agent writes to it. Nothing has changed
  // when a turn starts, so that edge is not worth a directory scan.
  createEffect(
    () => `${props.store.state.sessionId}:${props.store.isBusy()}`,
    () => {
      if (!props.store.isBusy()) {
        void props.store.listSessions().then(setSessions);
      }
    }
  );

  const go = (run: () => Promise<void>): void => {
    props.onNavigate?.();
    void run();
  };

  return (
    <div class="flex h-full flex-col bg-neutral-950">
      <div class="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <div class="flex items-center gap-2">
          <h1 class="font-bold">PIM</h1>
          <span class="rounded-full bg-neutral-850 px-2 py-0.5 text-xs text-neutral-350">
            {`v${version}`}
          </span>
        </div>
        <button
          type="button"
          aria-label="New session"
          title="New session"
          class="flex size-8 items-center justify-center rounded-lg text-neutral-350 hover:bg-neutral-850 hover:text-neutral-50"
          onClick={() => {
            go(() => props.store.newSession(props.store.state.cwd));
          }}
        >
          <span class="i-griddy-icons:chat-bubble-plus size-5" />
        </button>
      </div>

      <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto px-3">
        <Show
          when={sessions().length > 0}
          fallback={<li class="text-sm text-neutral-500">No sessions yet.</li>}
        >
          <For each={sessions()}>
            {(session) => (
              <li>
                <button
                  type="button"
                  class={{
                    "w-full space-y-1 rounded-lg px-3 py-2 text-left text-sm": true,
                    "bg-neutral-850":
                      session.sessionId === props.store.state.sessionId,
                    "text-neutral-300 hover:bg-neutral-900":
                      session.sessionId !== props.store.state.sessionId,
                  }}
                  onClick={() => {
                    go(() => props.store.switchTo(session.sessionId));
                  }}
                >
                  <div class="flex items-center justify-between gap-2">
                    {/* A session is named by its opening message; one that
                        has none on disk yet has only its id. */}
                    <div class="truncate font-semibold">
                      {session.title ?? session.sessionId.slice(0, 8)}
                    </div>
                    <Show when={props.store.isUnread(session)}>
                      <div
                        class="size-1.5 shrink-0 rounded-full bg-indigo-400"
                        aria-label="Unread"
                      />
                    </Show>
                  </div>
                  <div class="flex justify-between gap-6 text-neutral-400">
                    <div class="truncate">{abbreviateHome(session.cwd)}</div>
                    <div class="shrink-0">
                      {relativeTime(session.modifiedAt, now())}
                    </div>
                  </div>
                </button>
              </li>
            )}
          </For>
        </Show>
      </ul>

      <div class="flex shrink-0 items-center gap-1.5 border-t border-neutral-700 p-3 text-neutral-350">
        <span
          class={`i-griddy-icons:server size-4 ${CONNECTION_CLASSES[props.store.state.connection]}`}
          aria-hidden="true"
        />
        <span class="truncate text-sm leading-none">
          {hostOf(props.store.client.httpUrl)}
        </span>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  return URL.parse(url)?.host ?? url;
}
