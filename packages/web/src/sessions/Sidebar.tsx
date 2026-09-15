import {
  createEffect,
  createMemo,
  createSignal,
  type Element,
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
import { ACTION, FIELD_SKIN, ICON } from "../ui/classes";
import { RowMenu, type RowMenuControl, type RowMenuItem } from "../ui/RowMenu";
import { createPressMenu } from "../ui/pressMenu";
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
  /** Every file the directory holds, drawable or not; never shown, only ever asked whether it exceeds the rows. */
  readonly count: number;
  /** Newest settle time in it, which is where the group sorts. */
  readonly settledAt: number;
  /** Pinned projects stand above every other, whatever the clock says. */
  readonly pinned: boolean;
  /** Where it sorts among the pinned; meaningless for a project that is not. */
  readonly rank: number;
};

/** Which listing the sidebar is showing: the live sessions, or the ones put away. */
type View = "live" | "archived";

/** A row with nothing written to it yet is newer than anything that has settled. */
const UNSETTLED = Number.MAX_SAFE_INTEGER;

/** What one project contributes to a listing, and what one press of `Load more…` adds to it. */
const PER_PROJECT = 10;

/** The box one session row occupies, read or being named, so the swap between the two shifts nothing. */
const ROW_BOX = "min-w-0 flex-1 rounded-lg px-3 py-2 text-sm";

/** How many rows a project has been asked for, keyed by its working directory. */
type Pages = Readonly<Record<string, number>>;

/** The projects that answered short, which is the only word that a directory has no more rows to draw. */
type Ended = Readonly<Record<string, true>>;

/** What one listing answered, whole. */
type Answer = {
  readonly sessions: readonly SessionSummaryView[];
  readonly projects: readonly ProjectView[];
  readonly ended: Ended;
};

/**
 * Each view's last answer, kept so a flip repaints the listing it last saw and
 * refreshes underneath. A view missing from it has never answered, which is
 * not the same as having answered empty.
 */
type Answers = Readonly<Partial<Record<View, Answer>>>;

function settleOf(row: Row): number {
  return row.listed?.settledAt ?? UNSETTLED;
}

/**
 * A pin outranks the clock. Among the pinned it is the order somebody put them
 * in — a pin that changed places whenever a session answered in it would be no
 * order at all — and among the rest, the project answered in last stands first.
 */
function byPinThenSettle(one: Group, other: Group): number {
  if (one.pinned !== other.pinned) {
    return one.pinned ? -1 : 1;
  }
  if (one.pinned) {
    return one.rank - other.rank;
  }
  return other.settledAt - one.settledAt;
}

/** The session list, read straight off the server's sessions directory; `onNavigate` fires when a row is picked. */
export function Sidebar(props: {
  readonly store: SessionStore;
  readonly onNavigate?: () => void;
  readonly onOpenSearch?: () => void;
  readonly onOpenSettings?: () => void;
}) {
  const [answers, setAnswers] = createSignal<Answers>({});
  const [view, setView] = createSignal<View>("live");
  const [opened, setOpened] = createSignal<Record<string, boolean>>({});
  const [pages, setPages] = createSignal<Pages>({});
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

  const load = (store: SessionStore, which: View, asked: Pages): void => {
    // Bumped on every ask: two reads of one view overlap, and the slower of
    // them must not land last.
    const mine = ++generation;
    const archived: SessionScope =
      which === "archived" ? { archived: true } : {};
    const widened = Object.entries(asked);
    void Promise.all([
      store.listSessions({ ...archived, perProject: PER_PROJECT }),
      // A project the reader asked for more of, re-read at its own depth; the
      // flat page's cut stands for every other.
      Promise.all(
        widened.map(([cwd, size]) =>
          store.listSessions({
            ...archived,
            cwd,
            perProject: size,
            limit: size,
          })
        )
      ),
    ]).then(([listing, expanded]) => {
      if (mine !== generation) {
        return;
      }
      const short: Record<string, true> = {};
      for (const [at, [cwd, size]] of widened.entries()) {
        if ((expanded[at]?.sessions.length ?? 0) < size) {
          short[cwd] = true;
        }
      }
      setAnswers((was) => ({
        ...was,
        [which]: {
          sessions: [
            ...listing.sessions.filter((row) => asked[row.cwd] === undefined),
            ...expanded.flatMap((page) => page.sessions),
          ].sort((one, other) => other.settledAt - one.settledAt),
          projects: listing.projects,
          ended: short,
        },
      }));
    });
  };

  createEffect(
    () => ({
      store: props.store,
      view: view(),
      pages: pages(),
      sessionId: props.store.state.sessionId,
      connection: props.store.state.connection,
      catalogue: props.store.state.catalogue,
      running: props.store.runningIds(),
    }),
    (state, before) => {
      const stale =
        before === undefined ||
        before.view !== state.view ||
        before.pages !== state.pages ||
        before.sessionId !== state.sessionId ||
        before.catalogue !== state.catalogue ||
        (state.connection === "open" && before.connection !== "open") ||
        before.running.some((sessionId) => !state.running.includes(sessionId));
      if (stale) {
        load(state.store, state.view, state.pages);
      }
    }
  );

  // `unwrittenSummary` answers with a new object on every keystroke; compare by value to keep typing out of `rows`.
  const held = createMemo(() => props.store.unwrittenSummary(), {
    equals: (before, after) =>
      before?.sessionId === after?.sessionId && before?.cwd === after?.cwd,
  });

  const answer = createMemo(() => answers()[view()]);

  const rows = createMemo<readonly Row[]>(() => {
    const archived = view() === "archived";
    // Sieved against the store, not the answer: archiving a row takes it off
    // the list at the press, and a refusal that rolls the flag back returns it.
    const listed = (answer()?.sessions ?? [])
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
      (answer()?.projects ?? []).map((project) => [project.cwd, project.count])
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
        rank: props.store.pinRankOf(cwd),
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

  const fold = (cwd: string): void => {
    const open = shown(cwd);
    setOpened((was) => ({ ...was, [cwd]: !open }));
  };

  // A count of files is not a count of rows — a session with nothing to call
  // itself is never drawn — so the count only ever suggests more, and a short
  // answer is what settles it.
  const more = (group: Group): boolean =>
    answer()?.ended[group.cwd] === undefined && group.count > group.rows.length;

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
      load(props.store, untrack(view), untrack(pages));
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
    const order = props.store.pinOrder();
    const at = order.indexOf(cwd);
    return [
      {
        label: pinned ? "Unpin project" : "Pin project",
        onSelect: () => {
          attempt(() => props.store.setPinned(cwd, !pinned));
        },
      },
      // Greyed at the ends rather than dropped: with two pins every menu is an
      // end, and a verb that came and went would put `Move down` where `Move
      // up` had just been.
      ...(pinned
        ? [
            {
              label: "Move up",
              disabled: at <= 0,
              onSelect: () => {
                attempt(() => props.store.movePin(cwd, -1));
              },
            },
            {
              label: "Move down",
              disabled: at === -1 || at === order.length - 1,
              onSelect: () => {
                attempt(() => props.store.movePin(cwd, 1));
              },
            },
          ]
        : []),
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
            aria-label="Search sessions"
            title="Search sessions"
            class={ICON}
            onClick={() => props.onOpenSearch?.()}
          >
            <span class="i-griddy-icons:search size-5" />
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
        class="min-h-0 flex-1 space-y-1 overflow-y-auto py-2"
      >
        <Show
          when={rows().length > 0}
          fallback={
            <Show when={answer() !== undefined}>
              <div class="space-y-3 px-3 py-2">
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
            </Show>
          }
        >
          {/* Keyed: a listing answers with fresh groups, and an unkeyed `<For>` remounts every row under them. */}
          <For each={groups()} keyed={(group: Group) => group.cwd}>
            {(group) => (
              <div class="group min-w-0">
                <GroupHeader
                  cwd={group().cwd}
                  pinned={group().pinned}
                  open={shown(group().cwd)}
                  items={projectItems(group().cwd)}
                  onToggle={() => {
                    fold(group().cwd);
                  }}
                  onNew={() => {
                    setOpened((was) => ({ ...was, [group().cwd]: true }));
                    go(() => props.store.openDirectory(group().cwd));
                  }}
                />
                <Listing
                  store={props.store}
                  rows={group().rows}
                  folded={!shown(group().cwd)}
                  now={now()}
                  editing={editing()}
                  title={title}
                  items={items}
                  onOpen={attach}
                  onRename={rename}
                  onCancelRename={cancelRename}
                >
                  <Show when={shown(group().cwd) && more(group())}>
                    <li>
                      <button
                        type="button"
                        class="w-full rounded-lg px-3 py-1 text-left text-sm text-neutral-500 hover:text-neutral-300"
                        onClick={() => {
                          const cwd = group().cwd;
                          setPages((was) => ({
                            ...was,
                            [cwd]: (was[cwd] ?? PER_PROJECT) + PER_PROJECT,
                          }));
                        }}
                      >
                        {`Load more…`}
                      </button>
                    </li>
                  </Show>
                </Listing>
              </div>
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
            // The two listings are different scopes; a depth read into one says nothing about the other.
            setPages({});
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

/** What the directory is called, the caret that folds it, and what can be done to the project itself. */
function GroupHeader(props: {
  readonly cwd: string;
  readonly pinned: boolean;
  /** The group this heads is unfolded: its name is read first, so it is lit first. */
  readonly open: boolean;
  readonly items: readonly RowMenuItem[];
  readonly onToggle: () => void;
  readonly onNew: () => void;
}) {
  let menu: RowMenuControl | undefined;
  const press = createPressMenu((at) => menu?.open(at));

  const where = (): string => abbreviateHome(props.cwd);

  return (
    <div class="group/head ml-3 mr-3 mt-2 flex items-center gap-2.4 py-0.5 text-sm text-neutral-350">
      <h3 class="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={props.open ? "true" : "false"}
          class="flex w-full min-w-0 select-none items-center gap-2 text-left [-webkit-touch-callout:none]"
          onClick={() => {
            if (!press.swallowed()) {
              props.onToggle();
            }
          }}
          {...press.handlers}
        >
          <span
            class={{
              "i-griddy-icons:chevron-right-filled size-3 shrink-0 transition-transform": true,
              "rotate-90 bg-neutral-200": props.open,
              "bg-neutral-500 group-hover/head:bg-neutral-200": !props.open,
            }}
            aria-hidden="true"
          />
          <span
            class={{
              "truncate font-bold": true,
              "text-neutral-50": props.open,
              "text-neutral-400 group-hover/head:text-neutral-200": !props.open,
            }}
            title={where()}
          >
            {baseName(props.cwd)}
          </span>
          <Show when={props.pinned}>
            <span
              class="i-griddy-icons:pin size-3.5 shrink-0 rotate-45 text-neutral-400"
              aria-label="Pinned project"
            />
          </Show>
        </button>
      </h3>
      <span class="flex shrink-0 items-center">
        <button
          type="button"
          aria-label={`New session in ${baseName(props.cwd)}`}
          title={`New session in ${where()}`}
          class="flex shrink-0 items-center px-2 text-neutral-500 hover:text-neutral-100"
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
    </div>
  );
}

/**
 * The sessions themselves, under a group header. Folded, the rows stay where
 * they are and all but the one being read are put away: the session you are
 * in is the one line a closed project still answers with, and it is the same
 * element either way, so opening the project moves nothing around it.
 */
function Listing(props: {
  readonly store: SessionStore;
  readonly rows: readonly Row[];
  readonly folded: boolean;
  readonly now: number;
  readonly editing: string | undefined;
  readonly title: (row: Row) => string;
  readonly items: (row: Row) => readonly RowMenuItem[];
  readonly onOpen: (row: Row) => void;
  readonly onRename: (row: Row, text: string) => void;
  readonly onCancelRename: () => void;
  /** Whatever the group hangs under its rows, inside the spine and the same margins. */
  readonly children?: Element;
}) {
  const reading = (row: Row): boolean =>
    row.sessionId === props.store.state.sessionId;

  // `hidden` and `flex` both write `display`, so the fold swaps one for the
  // other rather than layering them and trusting the sheet's order.
  const away = (): boolean => props.folded && !props.rows.some(reading);

  return (
    <ul
      class={`ml-4.4 border-l border-neutral-700 pl-1 pr-3 pt-2 group-hover:border-neutral-500 ${away() ? "hidden" : "flex flex-col gap-1"}`}
    >
      {/* Keyed: a listing answers with fresh objects, and an unkeyed `<For>` remounts every row. */}
      <For each={props.rows} keyed={(row: Row) => row.sessionId}>
        {(row) => (
          <SessionRow
            store={props.store}
            row={row()}
            title={props.title(row())}
            hidden={props.folded && !reading(row())}
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
      {props.children}
    </ul>
  );
}

/** One session: the body attaches to it, the `⋯` beside it says what else can be done to it. */
function SessionRow(props: {
  readonly store: SessionStore;
  readonly row: Row;
  readonly title: string;
  readonly hidden: boolean;
  readonly editing: boolean;
  readonly items: readonly RowMenuItem[];
  readonly now: number;
  readonly onOpen: () => void;
  readonly onRename: (text: string) => void;
  readonly onCancelRename: () => void;
}) {
  let menu: RowMenuControl | undefined;
  const press = createPressMenu((at) => menu?.open(at));

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
      // Ungapped: the `⋯` is painted out until a caret lands on it, and a gap
      // ahead of a hidden trigger would hold the row's last glyph off the edge
      // every other row ends at.
      class={`group select-none [-webkit-touch-callout:none] ${props.hidden ? "hidden" : "flex items-center"}`}
      {...press.handlers}
    >
      <Show
        when={props.editing}
        fallback={
          <button
            type="button"
            aria-label={spoken()}
            class={{
              [`${ROW_BOX} flex items-center gap-2 text-left`]: true,
              "bg-neutral-850 font-bold text-neutral-100": selected(),
              "text-neutral-300 hover:bg-neutral-900": !selected(),
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
        // Uncontrolled: Solid rewrites an input's `value` on every run of this
        // element's props, and a running session re-lists under the caret.
        element.value = untrack(() => props.value);
      }}
      type="text"
      spellcheck={false}
      autocapitalize="off"
      autocomplete="off"
      aria-label={props.label}
      class={`${ROW_BOX} ${FIELD_SKIN}`}
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
