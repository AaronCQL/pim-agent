import {
  createEffect,
  createSignal,
  createStore,
  untrack,
  type Accessor,
  type Setter,
  type Store,
  type StoreSetter,
} from "solid-js";

import type { ChangeSummary, DiffBase, FileDiff } from "#protocol/Diff";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import type { SessionStore } from "../session/SessionStore";

/** The bases the selector offers; `commit` and `branch` exist on the wire and have no UI. */
export type BaseKind = Extract<
  DiffBase,
  { readonly kind: "worktree" | "unstaged" | "staged" }
>["kind"];

export type FileState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly diff: FileDiff;
      /** Lines behind a gap this reader has since opened, by their new-side number. */
      readonly lines: ReadonlyMap<number, string>;
      readonly opening: boolean;
      /** Why the last gap a reader opened stayed shut. */
      readonly failed?: string;
    }
  | { readonly kind: "error"; readonly message: string };

export type DiffState = {
  base: BaseKind;
  added: number;
  removed: number;
  /** The repository has more changed files than the list holds. */
  truncated: boolean;
  /** The repository moved under the list; a reader asks for the new one rather than being given it. */
  stale: boolean;
  /** `ready` only once a list has landed, so an empty overlay never claims a clean tree it has not read. */
  status: "idle" | "loading" | "ready";
  error: string | undefined;
};

/** A working copy's change set: what it is measured against, and the hunks read so far. */
export class DiffStore {
  public readonly state: Store<DiffState>;
  private readonly setState: StoreSetter<DiffState>;
  /** A whole snapshot at a time, outside the store: a proxied array would make every row a source of the list. */
  public readonly files: Accessor<readonly ChangeSummary[]>;
  private readonly setFiles: Setter<readonly ChangeSummary[]>;
  /** Flat and keyed by path, so a row tracks its own file and not every other row's. */
  private readonly diffs: Store<Record<string, FileState>>;
  private readonly setDiffs: StoreSetter<Record<string, FileState>>;
  private readonly session: SessionStore;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;

  public constructor(session: SessionStore) {
    this.session = session;
    const [state, setState] = createStore<DiffState>({
      base: "worktree",
      added: 0,
      removed: 0,
      truncated: false,
      stale: false,
      status: "idle",
      error: undefined,
    });
    const [diffs, setDiffs] = createStore<Record<string, FileState>>({});
    const [files, setFiles] = createSignal<readonly ChangeSummary[]>([]);
    this.state = state;
    this.setState = setState;
    this.diffs = diffs;
    this.setDiffs = setDiffs;
    this.files = files;
    this.setFiles = setFiles;

    createEffect(
      () => this.session.state.cwd,
      (cwd, previous) => {
        if (previous !== undefined && cwd !== previous) {
          this.reset();
        }
      }
    );

    createEffect(
      () => this.session.state.dirtyCount,
      (count, previous) => {
        if (previous !== undefined && count !== previous) {
          this.markStale();
        }
      }
    );
  }

  /** What is known about one file's hunks; absent until a reader expands it. */
  public fileState(path: string): FileState | undefined {
    return this.diffs[path];
  }

  /** The working copy these changes were read from. */
  public cwd(): string {
    return this.session.state.cwd;
  }

  /** Re-reads the file list and drops every hunk read against the last one. */
  public async refresh(): Promise<void> {
    const mine = ++this.generation;
    this.setState((draft) => {
      draft.status = "loading";
      draft.error = undefined;
      draft.stale = false;
    });
    this.forget();
    try {
      const changes = await this.enqueue(() =>
        this.session.listChanges(this.base())
      );
      if (mine !== this.generation) {
        return;
      }
      this.setFiles(changes.files);
      this.setState((draft) => {
        draft.added = changes.added;
        draft.removed = changes.removed;
        draft.truncated = changes.truncated === true;
        draft.status = "ready";
      });
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this.setFiles([]);
      this.setState((draft) => {
        draft.added = 0;
        draft.removed = 0;
        draft.truncated = false;
        draft.error = (error as Error).message;
        draft.status = "ready";
      });
    }
  }

  /** The repository changed under a list already read; nothing is re-read until a reader says so. */
  public markStale(): void {
    if (untrack(() => this.state.status) === "idle") {
      return;
    }
    this.setState((draft) => {
      draft.stale = true;
    });
  }

  /** Another working copy: every file, hunk and count read against the last one is void. */
  public reset(): void {
    this.generation += 1;
    this.forget();
    this.setFiles([]);
    this.setState((draft) => {
      draft.added = 0;
      draft.removed = 0;
      draft.truncated = false;
      draft.stale = false;
      draft.status = "idle";
      draft.error = undefined;
    });
  }

  public setBase(base: BaseKind): void {
    if (untrack(() => this.state.base) === base) {
      return;
    }
    this.setState((draft) => {
      draft.base = base;
    });
    void this.refresh();
  }

  /** The first expansion of a file reads it; every later one is answered from the cache. */
  public async expand(path: string): Promise<void> {
    if (untrack(() => this.diffs[path]) !== undefined) {
      return;
    }
    const mine = this.generation;
    this.setDiffs((draft) => {
      draft[path] = { kind: "loading" };
    });
    try {
      const diff = await this.enqueue(() =>
        this.session.fileDiff(path, this.base())
      );
      if (mine !== this.generation) {
        return;
      }
      this.setDiffs((draft) => {
        draft[path] = { kind: "ready", diff, lines: new Map(), opening: false };
      });
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this.setDiffs((draft) => {
        draft[path] = {
          kind: "error",
          message: (error as Error).message,
        };
      });
    }
  }

  /** Reads the lines behind one gap and splices them into the file already open. */
  public async open(path: string, gap: DiffGap): Promise<void> {
    const state = untrack(() => this.diffs[path]);
    if (state?.kind !== "ready" || state.opening) {
      return;
    }
    const mine = this.generation;
    this.setDiffs((draft) => {
      draft[path] = { ...state, opening: true, failed: undefined };
    });
    try {
      const read = await this.enqueue(() =>
        this.session.readLines(path, this.base(), DiffExpand.spans(gap))
      );
      if (mine !== this.generation) {
        return;
      }
      const lines = new Map(state.lines);
      for (const run of read.runs) {
        run.lines.forEach((text, index) => lines.set(run.start + index, text));
      }
      this.setDiffs((draft) => {
        draft[path] = { ...state, lines, opening: false, failed: undefined };
      });
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this.setDiffs((draft) => {
        draft[path] = {
          ...state,
          opening: false,
          failed: (error as Error).message,
        };
      });
    }
  }

  private forget(): void {
    this.setDiffs((draft) => {
      for (const path of Object.keys(draft)) {
        delete draft[path];
      }
    });
  }

  private base(): DiffBase {
    return { kind: untrack(() => this.state.base) };
  }

  /**
   * One request in flight at a time: the server reads through a `GitMonitor`
   * that refuses a second concurrent operation rather than queueing it, so two
   * expansions racing would fail one of themselves.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
