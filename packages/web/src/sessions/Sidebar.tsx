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
import { DirectoryModal } from "../topbar/DirectoryModal";
import { ACTION, FIELD, ICON } from "../ui/classes";
import { Collapsible } from "../ui/Collapsible";
import { RowMenu, type RowMenuControl, type RowMenuItem } from "../ui/RowMenu";
import { createPressMenu, type PressMenu } from "../ui/pressMenu";
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
  /** Pinned projects stand above every other, whatever the clock says. */
  readonly pinned: boolean;
};

/** Which listing the sidebar is showing: the live sessions, or the ones put away. */
type View = "live" | "archived";

/** A row with nothing written to it yet is newer than anything that has settled. */
const UNSETTLED = Number.MAX_SAFE_INTEGER;

/** What one project contributes to a listing before a reader asks for it whole. */
const PER_PROJECT = 10;

function settleOf(row: Row): number {
  return row.listed?.settledAt ?? UNSETTLED;
}

/** A pin outranks the clock; among equals, the project answered in last stands first. */
function byPinThenSettle(one: Group, other: Group): number {
  if (one.pinned !== other.pinned) {
    return one.pinned ? -1 : 1;
  }
  return other.settledAt - one.settledAt;
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
  const [opened, setOpened] = createSignal<Record<string, boolean>>({});
  const [whole, setWhole] = createSignal<readonly string[]>([]);
  const [editing, setEditing] = createSignal<string>();
  const [choosing, setChoosing] = createSignal(false);
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
        pinned: props.store.isPinned(cwd),
      }))
      .sort(byPinThenSettle);
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

  const projectItems = (cwd: string): readonly RowMenuItem[] => {
    const pinned = props.store.isPinned(cwd);
    return [
      {
        label: pinned ? "Unpin project" : "Pin project",
        onSelect: () => {
          attempt(() => props.store.setPinned(cwd, !pinned));
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
            aria-label="Settings"
            title="Settings"
            class={ICON}
            onClick={() => props.onOpenSettings?.()}
          >
            <span class="i-griddy-icons:settings size-5" />
          </button>
        </div>
      </div>

      <div class="shrink-0 px-3 pt-3">
        <input
          type="search"
          aria-label="Search sessions"
          placeholder="Search sessions"
          class={`${FIELD} w-full`}
        />
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
        class="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2"
      >
        <Show
          when={rows().length > 0}
          fallback={
            <div class="space-y-3 px-1 py-2">
              <p class="text-sm text-neutral-500">
                {view() === "archived"
                  ? "Nothing archived."
                  : "No sessions yet."}
              </p>
              <Show when={view() === "live"}>
                <button
                  type="button"
                  class={ACTION}
                  onClick={() => {
                    setChoosing(true);
                  }}
                >
                  New session
                </button>
              </Show>
            </div>
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
                summaryClass="mt-2 flex items-center gap-1.5 pr-1 text-sm text-neutral-350"
                summary={
                  <GroupHeader
                    cwd={group().cwd}
                    count={group().count}
                    pinned={group().pinned}
                    items={projectItems(group().cwd)}
                    onNew={() => {
                      setOpened((was) => ({ ...was, [group().cwd]: true }));
                      go(() => props.store.openDirectory(group().cwd));
                    }}
                  />
                }
              >
                <Listing
                  store={props.store}
                  rows={group().rows}
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

/** What the directory is called, how much it holds, and what can be done to the project itself. */
function GroupHeader(props: {
  readonly cwd: string;
  readonly count: number;
  readonly pinned: boolean;
  readonly items: readonly RowMenuItem[];
  readonly onNew: () => void;
}) {
  let menu: RowMenuControl | undefined;
  const press = createPressMenu(() => menu?.open());

  const where = (): string => abbreviateHome(props.cwd);

  return (
    <span
      ref={(element: HTMLElement) => {
        refuseHeld(element, press);
      }}
      class="flex min-w-0 flex-1 select-none items-center gap-2 [-webkit-touch-callout:none]"
      {...press.handlers}
    >
      <h3 class="truncate font-bold text-neutral-100" title={where()}>
        {baseName(props.cwd)}
      </h3>
      <Show when={props.count > 0}>
        <span class="shrink-0 text-neutral-400">{`(${props.count})`}</span>
      </Show>
      <Show when={props.pinned}>
        <span
          class="i-griddy-icons:pin-filled size-3.5 shrink-0 rotate-45 text-indigo-300"
          aria-label="Pinned project"
        />
      </Show>
      <span ref={refuseFold} class="ml-auto flex shrink-0 items-center">
        <button
          type="button"
          aria-label={`New session in ${baseName(props.cwd)}`}
          title={`New session in ${where()}`}
          class="flex size-6 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:text-neutral-100"
          onClick={props.onNew}
        >
          <span class="i-griddy-icons:plus size-4" aria-hidden="true" />
        </button>
        <RowMenu
          label={`Project options for ${where()}`}
          items={props.items}
          control={(control) => {
            menu = control;
          }}
        />
      </span>
    </span>
  );
}

/**
 * The header is a `<summary>`, which takes a press anywhere inside it for a
 * press on itself and folds the group. A listener on the element rather than a
 * delegated `onClick`: the disclosure reads the press before the document does.
 */
function refuseFold(element: HTMLElement): void {
  element.addEventListener("click", (event: Event) => {
    event.preventDefault();
  });
}

/** The click a long press leaves behind must not fold the group it opened the verbs on. */
function refuseHeld(element: HTMLElement, press: PressMenu): void {
  element.addEventListener("click", (event: Event) => {
    if (press.swallowed()) {
      event.preventDefault();
    }
  });
}

/** The sessions themselves, under a group header or flat under none. */
function Listing(props: {
  readonly store: SessionStore;
  readonly rows: readonly Row[];
  readonly now: number;
  readonly editing: string | undefined;
  readonly title: (row: Row) => string;
  readonly items: (row: Row) => readonly RowMenuItem[];
  readonly onOpen: (row: Row) => void;
  readonly onRename: (row: Row, text: string) => void;
  readonly onCancelRename: () => void;
}) {
  return (
    <ul class="ml-[0.9rem] space-y-1 border-l border-neutral-700 py-2 pl-1 pr-1">
      {/* Keyed: a listing answers with fresh objects, and an unkeyed `<For>` remounts every row. */}
      <For each={props.rows} keyed={(row: Row) => row.sessionId}>
        {(row) => (
          <SessionRow
            store={props.store}
            row={row()}
            title={props.title(row())}
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
  readonly editing: boolean;
  readonly items: readonly RowMenuItem[];
  readonly now: number;
  readonly onOpen: () => void;
  readonly onRename: (text: string) => void;
  readonly onCancelRename: () => void;
}) {
  let menu: RowMenuControl | undefined;
  const press = createPressMenu(() => menu?.open());

  const selected = (): boolean =>
    props.row.sessionId === props.store.state.sessionId;

  const age = (): string | undefined =>
    props.row.listed === undefined
      ? undefined
      : relativeTime(props.row.listed.settledAt, props.now);

  const drafted = (): boolean =>
    props.store.draftText(props.row.sessionId) !== "";

  const spoken = (): string => {
    const said = [props.title];
    if (drafted()) {
      said.push("unsent draft");
    }
    if (props.store.isRunning(props.row.sessionId)) {
      said.push("working");
    } else if (props.store.isUnread(props.row.sessionId)) {
      said.push("unread");
    } else if (age() !== undefined) {
      said.push(age() ?? "");
    }
    return said.join(", ");
  };

  return (
    <li
      class="group flex select-none items-center gap-1 [-webkit-touch-callout:none]"
      {...press.handlers}
    >
      <Show
        when={props.editing}
        fallback={
          <button
            type="button"
            aria-label={spoken()}
            class={{
              "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm": true,
              "bg-neutral-850 font-bold text-neutral-100": selected(),
              "text-neutral-350 hover:bg-neutral-900": !selected(),
            }}
            onClick={() => {
              if (!press.swallowed()) {
                props.onOpen();
              }
            }}
          >
            <span class="min-w-0 flex-1 truncate">{props.title}</span>
            <Show when={drafted()}>
              <span
                class="i-griddy-icons:edit size-3.5 shrink-0 text-amber-300"
                aria-hidden="true"
                title="Unsent draft"
              />
            </Show>
            <Switch>
              <Match when={props.store.isRunning(props.row.sessionId)}>
                <Spinner />
              </Match>
              <Match when={props.store.isUnread(props.row.sessionId)}>
                <span
                  class="size-1.5 shrink-0 rounded-full bg-indigo-400"
                  aria-hidden="true"
                />
              </Match>
              <Match when={age()}>
                {(shown) => (
                  <span class="shrink-0 font-light text-neutral-400">
                    {shown()}
                  </span>
                )}
              </Match>
            </Switch>
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
