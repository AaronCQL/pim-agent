import { createStore, untrack, type Store, type StoreSetter } from "solid-js";

import type { ChangeSummary, DiffBase, FileDiff } from "#protocol/Diff";
import type { SessionStore } from "../session/SessionStore";

/** The bases the selector offers; `commit` and `branch` exist on the wire and have no UI. */
export type BaseKind = Extract<
  DiffBase,
  { readonly kind: "worktree" | "unstaged" | "staged" }
>["kind"];

export type FileState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly diff: FileDiff }
  | { readonly kind: "error"; readonly message: string };

export type DiffState = {
  base: BaseKind;
  files: readonly ChangeSummary[];
  added: number;
  removed: number;
  /** `ready` only once a list has landed, so an empty overlay never claims a clean tree it has not read. */
  status: "idle" | "loading" | "ready";
  error: string | undefined;
  /** By path, and a record rather than a map because only the record is reactive. */
  hunks: Record<string, FileState>;
};

/** One overlay's change set: what it is measured against, and the hunks read so far. */
export class DiffStore {
  public readonly state: Store<DiffState>;
  private readonly setState: StoreSetter<DiffState>;
  private readonly session: SessionStore;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;

  public constructor(session: SessionStore) {
    this.session = session;
    const [state, setState] = createStore<DiffState>({
      base: "worktree",
      files: [],
      added: 0,
      removed: 0,
      status: "idle",
      error: undefined,
      hunks: {},
    });
    this.state = state;
    this.setState = setState;
  }

  /** Re-reads the file list and drops every hunk read against the last one. */
  public async refresh(): Promise<void> {
    const mine = ++this.generation;
    this.setState((draft) => {
      draft.status = "loading";
      draft.error = undefined;
      draft.hunks = {};
    });
    try {
      const changes = await this.enqueue(() =>
        this.session.listChanges(this.base())
      );
      if (mine !== this.generation) {
        return;
      }
      this.setState((draft) => {
        draft.files = changes.files;
        draft.added = changes.added;
        draft.removed = changes.removed;
        draft.status = "ready";
      });
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this.setState((draft) => {
        draft.files = [];
        draft.added = 0;
        draft.removed = 0;
        draft.error = (error as Error).message;
        draft.status = "ready";
      });
    }
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
    if (untrack(() => this.state.hunks[path]) !== undefined) {
      return;
    }
    const mine = this.generation;
    this.setState((draft) => {
      draft.hunks[path] = { kind: "loading" };
    });
    try {
      const diff = await this.enqueue(() =>
        this.session.fileDiff(path, this.base())
      );
      if (mine !== this.generation) {
        return;
      }
      this.setState((draft) => {
        draft.hunks[path] = { kind: "ready", diff };
      });
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this.setState((draft) => {
        draft.hunks[path] = {
          kind: "error",
          message: (error as Error).message,
        };
      });
    }
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
