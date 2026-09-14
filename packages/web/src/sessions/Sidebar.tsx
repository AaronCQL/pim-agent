import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";

import type { ProjectView, SessionSummaryView } from "#protocol/ServerEvent";
import { version } from "../../../../package.json";
import type { SessionScope, SessionStore } from "../session/SessionStore";
import { abbreviateHome, baseName, relativeTime } from "../format";
import { FIELD, ICON } from "../ui/classes";
import { Collapsible } from "../ui/Collapsible";
import { Fitted } from "../ui/Fitted";
import { RowMenu, type RowMenuControl, type RowMenuItem } from "../ui/RowMenu";
import { Spinner } from "../ui/Spinner";

type Row = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly listed: SessionSummaryView | undefined;
};

/** One working directory's sessions, with what the page of them left behind. */
type Group = {
  readonly cwd: string;
  readonly rows: readonly Row[];
  /** Every session the directory holds, page or no page. */
  readonly count: number;
  /** Newest settle time in it, which is where the group sorts. */
  readonly settledAt: number;
};

/** Which listing the sidebar is showing: the live sessions, or the ones put away. */
type View = "live" | "archived";

/** A row with nothing written to it yet is newer than anything that has settled. */
const UNSETTLED = Number.MAX_SAFE_INTEGER;

/** What one project contributes to a listing before a reader asks for it whole. */
const PER_PROJECT = 10;

const GROUPING_KEY = "pim.sidebar.grouping";

function settleOf(row: Row): number {
  return row.listed?.settledAt ?? UNSETTLED;
}

/** The session list, read straight off the server's sessions directory; `onNavigate` fires when a row is picked. */
export function Sidebar(props: {
  readonly store: SessionStore;
  readonly onNavigate?: () => void;
  readonly onOpenSettings?: () => void;
}) {
  const [sessions, setSessions] = createSignal<readonly SessionSummaryView[]>(
    []
  );
  const [projects, setProjects] = createSignal<readonly ProjectView[]>([]);
  const [view, setView] = createSignal<View>("live");
  const [grouping, setGrouping] = createSignal(readGrouping());
  const [opened, setOpened] = createSignal<Record<string, boolean>>({});
  const [whole, setWhole] = createSignal<readonly string[]>([]);
  const [editing, setEditing] = createSignal<string>();
  const [failure, setFailure] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => {
    setNow(Date.now());
  }, 1000);
  onCleanup(() => {
    clearInterval(clock);
  });

  let generation = 0;

  const load = (
    store: SessionStore,
    which: View,
    asked: readonly string[]
  ): void => {
    // Bumped on every ask: the archived listing and the live one answer into
    // the same rows, and the slower of two must not land last.
    const mine = ++generation;
    const scope = (cwd?: string): SessionScope => ({
      ...(which === "archived" ? { archived: true } : {}),
      ...(cwd === undefined ? { perProject: PER_PROJECT } : { cwd }),
    });
    void Promise.all([
      store.listSessions(scope()),
      // A project the reader asked to see whole; the cut stands for the rest.
      Promise.all(asked.map((cwd) => store.listSessions(scope(cwd)))),
    ]).then(([listing, expanded]) => {
      if (mine !== generation) {
        return;
      }
      const rest = expanded.flatMap((answer) => answer.sessions);
      setSessions(
        [
          ...listing.sessions.filter((row) => !asked.includes(row.cwd)),
          ...rest,
        ].sort((one, other) => other.settledAt - one.settledAt)
      );
      setProjects(listing.projects);
    });
  };

  createEffect(
    () => ({
      store: props.store,
      view: view(),
      whole: whole(),
      sessionId: props.store.state.sessionId,
      connection: props.store.state.connection,
      catalogue: props.store.state.catalogue,
      running: props.store.runningIds(),
    }),
    (state, before) => {
      const stale =
        before === undefined ||
        before.view !== state.view ||
        before.whole !== state.whole ||
        before.sessionId !== state.sessionId ||
        before.catalogue !== state.catalogue ||
        (state.connection === "open" && before.connection !== "open") ||
        before.running.some((sessionId) => !state.running.includes(sessionId));
      if (stale) {
        load(state.store, state.view, state.whole);
      }
    }
  );

  // `unwrittenSummary` answers with a new object on every keystroke; compare by value to keep typing out of `rows`.
  const held = createMemo(() => props.store.unwrittenSummary(), {
    equals: (before, after) =>
      before?.sessionId === after?.sessionId && before?.cwd === after?.cwd,
  });

  const rows = createMemo<readonly Row[]>(() => {
    const archived = view() === "archived";
    // Sieved against the store, not the answer: archiving a row takes it off
    // the list at the press, and a refusal that rolls the flag back returns it.
    const listed = sessions()
      .filter(
        (session) => props.store.isArchived(session.sessionId) === archived
      )
      .map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        listed: session,
      }));
    const unwritten = held();
    if (
      archived ||
      !unwritten ||
      listed.some((row) => row.sessionId === unwritten.sessionId)
    ) {
      return listed;
    }
    return [{ ...unwritten, listed: undefined }, ...listed];
  });

  const groups = createMemo<readonly Group[]>(() => {
    const counted = new Map(
      projects().map((project) => [project.cwd, project.count])
    );
    const byDirectory = new Map<string, Row[]>();
    for (const row of rows()) {
      const found = byDirectory.get(row.cwd);
      if (found === undefined) {
        byDirectory.set(row.cwd, [row]);
      } else {
        found.push(row);
      }
    }
    return [...byDirectory]
      .map(([cwd, found]) => ({
        cwd,
        rows: found,
        count: Math.max(counted.get(cwd) ?? 0, found.length),
        settledAt: Math.max(...found.map(settleOf)),
      }))
      .sort((one, other) => other.settledAt - one.settledAt);
  });

  // Derived rather than remembered: which project you are working in is the
  // one thing a sidebar of ten collapsed lines has to answer without a click.
  const opening = createMemo((): string | undefined => {
    const here = props.store.state.cwd;
    const all = groups();
    return all.some((group) => group.cwd === here) ? here : all[0]?.cwd;
  });

  const shown = (cwd: string): boolean => opened()[cwd] ?? cwd === opening();

  const hidden = (group: Group): number =>
    whole().includes(group.cwd) ? 0 : group.count - group.rows.length;

  const title = (row: Row): string =>
    props.store.sessionName(row.sessionId) ??
    row.listed?.title ??
    props.store.localTitle(row.sessionId) ??
    row.sessionId.slice(0, 8);

  const go = (run: () => Promise<void>): void => {
    props.onNavigate?.();
    void run().catch(() => undefined);
  };

  const attach = (row: Row): void => {
    go(() => props.store.switchTo(row.sessionId));
  };

  const cancelRename = (): void => {
    setEditing(undefined);
  };

  const regroup = (): void => {
    const next = !untrack(grouping);
    writeGrouping(next);
    setGrouping(next);
  };

  /** A verb the row spells out: nowhere to navigate to, and a refusal is said rather than swallowed. */
  const attempt = (run: () => Promise<void>): void => {
    setFailure("");
    void run().catch((error: Error) => {
      setFailure(error.message);
    });
  };

  const rename = (row: Row, text: string): void => {
    setEditing(undefined);
    const name = text.trim();
    if (name === title(row).trim()) {
      return;
    }
    attempt(async () => {
      await props.store.rename(row.sessionId, name === "" ? null : name);
      // A cleared name falls back to a digest of the first message, which only the server holds.
      load(props.store, untrack(view), untrack(whole));
    });
  };

  const items = (row: Row): readonly RowMenuItem[] => {
    const sessionId = row.sessionId;
    const unread = props.store.isUnread(sessionId);
    const archived = props.store.isArchived(sessionId);
    return [
      {
        label: "Rename",
        onSelect: () => {
          setFailure("");
          setEditing(sessionId);
        },
      },
      {
        label: unread ? "Mark read" : "Mark unread",
        onSelect: () => {
          attempt(() => props.store.markUnread(sessionId, !unread));
        },
      },
      {
        label: archived ? "Unarchive" : "Archive",
        onSelect: () => {
          attempt(() => props.store.setArchived(sessionId, !archived));
        },
      },
    ];
  };

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
            aria-label="Group by directory"
            aria-pressed={grouping() ? "true" : "false"}
            title={grouping() ? "Grouped by directory" : "Most recent first"}
            class={ICON}
            onClick={regroup}
          >
            <span
              class={`size-5 ${grouping() ? "i-griddy-icons:folder" : "i-griddy-icons:time-back"}`}
              aria-hidden="true"
            />
          </button>
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

      <Show when={failure()}>
        {(message) => (
          <p
            role="alert"
            class="shrink-0 border-b border-neutral-750 px-3 py-2 text-xs text-rose-400"
          >
            {message()}
          </p>
        )}
      </Show>

      <nav
        aria-label="Sessions"
        class="min-h-0 flex-1 space-y-1 overflow-y-auto p-3"
      >
        <Show
          when={rows().length > 0}
          fallback={
            <p class="text-sm text-neutral-500">
              {view() === "archived" ? "Nothing archived." : "No sessions yet."}
            </p>
          }
        >
          <Show
            when={grouping()}
            fallback={
              <Listing
                store={props.store}
                rows={rows()}
                directory
                now={now()}
                editing={editing()}
                title={title}
                items={items}
                onOpen={attach}
                onRename={rename}
                onCancelRename={cancelRename}
              />
            }
          >
            {/* Keyed: a listing answers with fresh groups, and an unkeyed `<For>` remounts every row under them. */}
            <For each={groups()} keyed={(group: Group) => group.cwd}>
              {(group) => (
                <Collapsible
                  gutter={false}
                  open={shown(group().cwd)}
                  onToggle={(open) => {
                    setOpened((was) => ({ ...was, [group().cwd]: open }));
                  }}
                  summaryClass="flex items-center gap-1 rounded-lg py-1 pr-2 text-sm text-neutral-350 hover:bg-neutral-900 hover:text-neutral-100"
                  summary={
                    <GroupHeader
                      cwd={group().cwd}
                      count={group().count}
                      open={shown(group().cwd)}
                    />
                  }
                >
                  <Listing
                    store={props.store}
                    rows={group().rows}
                    directory={false}
                    now={now()}
                    editing={editing()}
                    title={title}
                    items={items}
                    onOpen={attach}
                    onRename={rename}
                    onCancelRename={cancelRename}
                  />
                  <Show when={hidden(group()) > 0}>
                    <button
                      type="button"
                      class="w-full rounded-lg px-3 py-1 text-left text-sm text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                      onClick={() => {
                        setWhole((was) => [...was, group().cwd]);
                      }}
                    >
                      {`Show ${hidden(group())} more`}
                    </button>
                  </Show>
                </Collapsible>
              )}
            </For>
          </Show>
        </Show>
      </nav>

      <div class="shrink-0 border-t border-neutral-750 p-2">
        <button
          type="button"
          aria-pressed={view() === "archived" ? "true" : "false"}
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-350 hover:bg-neutral-900 hover:text-neutral-100"
          onClick={() => {
            setFailure("");
            setEditing(undefined);
            setView((was) => (was === "archived" ? "live" : "archived"));
          }}
        >
          <span
            class={`size-4 ${view() === "archived" ? "i-griddy-icons:arrow-left" : "i-griddy-icons:archive"}`}
            aria-hidden="true"
          />
          {view() === "archived" ? "Back to sessions" : "Archived"}
        </button>
      </div>
    </div>
  );
}

/** What the directory is called, and how much of it a collapsed group is standing in for. */
function GroupHeader(props: {
  readonly cwd: string;
  readonly count: number;
  readonly open: boolean;
}) {
  return (
    <>
      <span
        class="flex min-w-0 flex-1 items-center gap-1.5"
        title={abbreviateHome(props.cwd)}
      >
        <span class="i-griddy-icons:folder size-3.5 shrink-0" />
        <Fitted
          class="flex-1 font-semibold"
          texts={[abbreviateHome(props.cwd), baseName(props.cwd)]}
        />
      </span>
      <Show when={!props.open}>
        <span class="shrink-0 text-xs text-neutral-500">{props.count}</span>
      </Show>
    </>
  );
}

/** The sessions themselves, under a group header or flat under none. */
function Listing(props: {
  readonly store: SessionStore;
  readonly rows: readonly Row[];
  /** Every row says which directory it is in; grouped, the header has said it. */
  readonly directory: boolean;
  readonly now: number;
  readonly editing: string | undefined;
  readonly title: (row: Row) => string;
  readonly items: (row: Row) => readonly RowMenuItem[];
  readonly onOpen: (row: Row) => void;
  readonly onRename: (row: Row, text: string) => void;
  readonly onCancelRename: () => void;
}) {
  return (
    <ul class="space-y-2">
      {/* Keyed: a listing answers with fresh objects, and an unkeyed `<For>` remounts every row. */}
      <For each={props.rows} keyed={(row: Row) => row.sessionId}>
        {(row) => (
          <SessionRow
            store={props.store}
            row={row()}
            title={props.title(row())}
            directory={props.directory}
            editing={props.editing === row().sessionId}
            items={props.items(row())}
            now={props.now}
            onOpen={() => {
              props.onOpen(row());
            }}
            onRename={(text) => {
              props.onRename(row(), text);
            }}
            onCancelRename={props.onCancelRename}
          />
        )}
      </For>
    </ul>
  );
}

/** One session: the body attaches to it, the `⋯` beside it says what else can be done to it. */
function SessionRow(props: {
  readonly store: SessionStore;
  readonly row: Row;
  readonly title: string;
  readonly directory: boolean;
  readonly editing: boolean;
  readonly items: readonly RowMenuItem[];
  readonly now: number;
  readonly onOpen: () => void;
  readonly onRename: (text: string) => void;
  readonly onCancelRename: () => void;
}) {
  let menu: RowMenuControl | undefined;

  const selected = (): boolean =>
    props.row.sessionId === props.store.state.sessionId;

  const age = (): string | undefined =>
    props.row.listed === undefined
      ? undefined
      : relativeTime(props.row.listed.settledAt, props.now);

  return (
    <li
      class="group flex items-center gap-1"
      onContextMenu={(event: MouseEvent) => {
        if (menu) {
          event.preventDefault();
          menu.open();
        }
      }}
    >
      <Show
        when={props.editing}
        fallback={
          <button
            type="button"
            class={{
              "min-w-0 flex-1 space-y-1 rounded-lg px-3 py-2 text-left text-sm": true,
              "bg-neutral-850": selected(),
              "text-neutral-300 hover:bg-neutral-900": !selected(),
            }}
            onClick={props.onOpen}
          >
            <div class="flex items-center justify-between gap-2">
              <div class="truncate font-semibold">{props.title}</div>
              <Show when={props.store.isUnread(props.row.sessionId)}>
                <div
                  class="size-1.5 shrink-0 rounded-full bg-indigo-400"
                  aria-label="Unread"
                />
              </Show>
            </div>
            <div class="flex items-center justify-between gap-6 text-neutral-400">
              <Show when={props.directory}>
                <div class="truncate" title={abbreviateHome(props.row.cwd)}>
                  {baseName(props.row.cwd)}
                </div>
              </Show>
              <div class="ml-auto flex shrink-0 items-center gap-1.5">
                <Show when={props.store.draftText(props.row.sessionId) !== ""}>
                  <span
                    class="i-griddy-icons:edit size-3 text-amber-400"
                    aria-label="Unsent draft"
                    title="Unsent draft"
                  />
                </Show>
                <Switch>
                  <Match when={props.store.isRunning(props.row.sessionId)}>
                    <Spinner />
                  </Match>
                  <Match when={age()}>
                    {(shown) => <span>{shown()}</span>}
                  </Match>
                </Switch>
              </div>
            </div>
          </button>
        }
      >
        <RenameBox
          value={props.title}
          label={`Rename ${props.title}`}
          onCommit={props.onRename}
          onCancel={props.onCancelRename}
        />
      </Show>

      {/* A session that is not a file yet has no name to write, nowhere to be put away to and no dot to hold. */}
      <Show when={props.row.listed !== undefined}>
        <RowMenu
          label={`Options for ${props.title}`}
          items={props.items}
          control={(control) => {
            menu = control;
          }}
        />
      </Show>
    </li>
  );
}

/** The row, being named: one line that takes the caret as it arrives, commits on Enter and gives up on Escape. */
function RenameBox(props: {
  readonly value: string;
  readonly label: string;
  readonly onCommit: (text: string) => void;
  readonly onCancel: () => void;
}) {
  let box: HTMLInputElement | undefined;
  let settled = false;

  onSettled(() => {
    box?.focus();
    box?.setSelectionRange(0, box.value.length);
  });

  const commit = (): void => {
    if (settled || !box) {
      return;
    }
    settled = true;
    props.onCommit(box.value);
  };

  return (
    <input
      ref={(element: HTMLInputElement) => {
        box = element;
      }}
      type="text"
      value={props.value}
      spellcheck={false}
      autocapitalize="off"
      autocomplete="off"
      aria-label={props.label}
      class={FIELD}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          settled = true;
          props.onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}

/** Which fold this browser was last left in; a preference of the device, not of the session. */
function readGrouping(): boolean {
  try {
    return localStorage.getItem(GROUPING_KEY) !== "recent";
  } catch {
    return true;
  }
}

function writeGrouping(group: boolean): void {
  try {
    localStorage.setItem(GROUPING_KEY, group ? "directory" : "recent");
  } catch {
    // Private mode or a full quota; the fold still holds for this tab.
  }
}
