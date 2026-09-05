import { createEffect, createSignal, For, Show } from "solid-js";

import type { SessionSummaryView } from "#protocol/ServerEvent";
import type { SessionStore } from "../session/SessionStore";
import { Dialog } from "../ui/Dialog";

type Group = {
  readonly cwd: string;
  readonly sessions: readonly SessionSummaryView[];
};

/**
 * The session list, grouped the way pi already stores it: one directory per
 * cwd, keyed on pi's session UUID. There is no index and
 * no metadata store on either side — the server reads its own sessions
 * directory when asked, so a session the TUI started shows up here with no
 * synchronisation at all.
 *
 * Switching re-attaches the existing socket at `fromSeq: 0`; the connection
 * outlives the session it points at, and every session outlives every
 * connection to it.
 */
export function SessionSwitcher(props: { readonly store: SessionStore }) {
  const [open, setOpen] = createSignal(false);
  const [groups, setGroups] = createSignal<readonly Group[]>([]);

  createEffect(
    () => open(),
    (isOpen) => {
      if (isOpen) {
        void props.store.listSessions().then((rows) => {
          setGroups(groupByCwd(rows));
        });
      }
    }
  );

  return (
    <>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        onClick={() => {
          setOpen(true);
        }}
      >
        <span class="i-lucide-list-tree block" aria-hidden="true" />
        Sessions
      </button>

      <Dialog
        open={open()}
        label="Sessions"
        onClose={() => {
          setOpen(false);
        }}
      >
        <div class="flex max-h-[80dvh] flex-col">
          <header class="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
            <h2 class="font-medium text-neutral-100">Sessions</h2>
            <button
              type="button"
              class="rounded bg-sky-900/70 px-3 py-1 text-sm text-sky-100 hover:bg-sky-800"
              onClick={() => {
                setOpen(false);
                void props.store.newSession(props.store.state.cwd);
              }}
            >
              New in this directory
            </button>
          </header>
          <div class="overflow-y-auto px-4 py-2">
            <Show
              when={groups().length > 0}
              fallback={<p class="py-4 text-neutral-500">No sessions yet.</p>}
            >
              <For each={groups()}>
                {(group) => (
                  <section class="py-2">
                    <h3 class="truncate font-mono text-xs text-neutral-500">
                      {group.cwd}
                    </h3>
                    <ul class="mt-1 flex flex-col">
                      <For each={group.sessions}>
                        {(session) => (
                          <li>
                            <button
                              type="button"
                              class={{
                                "flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-neutral-800": true,
                                "bg-neutral-800 text-neutral-100":
                                  session.sessionId ===
                                  props.store.state.sessionId,
                              }}
                              onClick={() => {
                                setOpen(false);
                                void props.store.switchTo(session.sessionId);
                              }}
                            >
                              <span class="truncate font-mono text-xs">
                                {session.sessionId.slice(0, 8)}
                              </span>
                              <span class="shrink-0 text-xs text-neutral-500">
                                {when(session.modifiedAt)}
                              </span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function groupByCwd(sessions: readonly SessionSummaryView[]): readonly Group[] {
  const byCwd = new Map<string, SessionSummaryView[]>();
  for (const session of sessions) {
    const bucket = byCwd.get(session.cwd);
    if (bucket) {
      bucket.push(session);
    } else {
      byCwd.set(session.cwd, [session]);
    }
  }
  return [...byCwd].map(([cwd, rows]) => ({ cwd, sessions: rows }));
}

function when(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
