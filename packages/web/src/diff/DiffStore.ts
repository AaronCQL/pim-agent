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

/** `commit` and `branch` bases exist on the wire but have no UI. */
export type BaseKind = Extract<
  DiffBase,
  { readonly kind: "worktree" | "unstaged" | "staged" }
>["kind"];

export type FileState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly diff: FileDiff;
      /** Lines revealed from opened gaps, keyed by new-side line number. */
      readonly lines: ReadonlyMap<number, string>;
      readonly opening: boolean;
      /** Error from the last gap open. */
      readonly failed?: string;
    }
  | { readonly kind: "error"; readonly message: string };

export type DiffState = {
  base: BaseKind;
  added: number;
  removed: number;
  truncated: boolean;
  /** `ready` only once a list has landed, so an empty list never means "clean" before it is read. */
  status: "idle" | "loading" | "ready";
  error: string | undefined;
  /** Kept here so closing the modal keeps the draft. */
  message: string;
  committing: boolean;
  failure: string | undefined;
  /** Short sha of the last commit. */
  committed: string | undefined;
};

/** Debounce for re-reading after repo changes. */
const SETTLE_MS = 200;

export class DiffStore {
  public readonly state: Store<DiffState>;
  private readonly setState: StoreSetter<DiffState>;
  /** A signal, not a store, so rows don't each subscribe to the list. */
  public readonly files: Accessor<readonly ChangeSummary[]>;
  private readonly setFiles: Setter<readonly ChangeSummary[]>;
  private readonly diffs: Store<Record<string, FileState>>;
  private readonly setDiffs: StoreSetter<Record<string, FileState>>;
  private readonly opened: Store<Record<string, boolean>>;
  private readonly setOpened: StoreSetter<Record<string, boolean>>;
  private readonly session: SessionStore;
  private readonly settleMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  /** `repoRevision` when the current list was read. */
  private synced = "";
  private watching = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private syncing = false;
  private resync = false;

  public constructor(session: SessionStore, settleMs: number = SETTLE_MS) {
    this.session = session;
    this.settleMs = settleMs;
    const [state, setState] = createStore<DiffState>({
      base: "worktree",
      added: 0,
      removed: 0,
      truncated: false,
      status: "idle",
      error: undefined,
      message: "",
      committing: false,
      failure: undefined,
      committed: undefined,
    });
    const [diffs, setDiffs] = createStore<Record<string, FileState>>({});
    const [opened, setOpened] = createStore<Record<string, boolean>>({});
    const [files, setFiles] = createSignal<readonly ChangeSummary[]>([]);
    this.state = state;
    this.setState = setState;
    this.diffs = diffs;
    this.setDiffs = setDiffs;
    this.opened = opened;
    this.setOpened = setOpened;
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
      () => this.session.state.repoRevision,
      (revision, previous) => {
        if (previous !== undefined && revision !== previous) {
          this.schedule();
        }
      }
    );
  }

  /** Undefined until the file is expanded. */
  public fileState(path: string): FileState | undefined {
    return this.diffs[path];
  }

  public cwd(): string {
    return this.session.state.cwd;
  }

  public async refresh(): Promise<void> {
    ++this.generation;
    this.setState((draft) => {
      draft.status = "loading";
      draft.error = undefined;
    });
    this.forget();
    await this.load(false);
  }

  /** Only a watched store re-reads on repo changes. */
  public watch(active: boolean): void {
    this.watching = active;
    if (active) {
      void this.sync();
    } else {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (!this.watching) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync();
    }, this.settleMs);
  }

  /** Quiet re-read: no loading state. */
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.resync = true;
      return;
    }
    const revision = untrack(() => this.session.state.repoRevision);
    if (
      untrack(() => this.state.status) === "idle" ||
      revision === this.synced
    ) {
      return;
    }
    // The first revision seen after the initial read is not a change.
    if (this.synced === "") {
      this.synced = revision;
      return;
    }
    this.syncing = true;
    try {
      await this.load(true);
    } finally {
      this.syncing = false;
      if (this.resync) {
        this.resync = false;
        void this.sync();
      }
    }
  }

  /** A quiet load keeps surviving rows and re-reads the hunks of changed ones. */
  private async load(quiet: boolean): Promise<void> {
    const mine = this.generation;
    this.synced = untrack(() => this.session.state.repoRevision);
    try {
      const changes = await this.enqueue(() =>
        this.session.listChanges(this.base())
      );
      if (mine !== this.generation) {
        return;
      }
      const moved = quiet ? this.reconcileDiffs(changes.files) : [];
      this.setFiles(changes.files);
      this.setState((draft) => {
        draft.added = changes.added;
        draft.removed = changes.removed;
        draft.truncated = changes.truncated === true;
        draft.error = undefined;
        draft.status = "ready";
      });
      for (const path of moved) {
        void this.read(path);
      }
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this.setFiles([]);
      this.forget();
      this.setState((draft) => {
        draft.added = 0;
        draft.removed = 0;
        draft.truncated = false;
        draft.error = (error as Error).message;
        draft.status = "ready";
      });
    }
  }

  /** Drops hunks of files no longer listed; returns the paths whose content changed. */
  private reconcileDiffs(files: readonly ChangeSummary[]): readonly string[] {
    const next = new Map(files.map((file) => [file.path, file.fingerprint]));
    const held = new Map(
      untrack(() => this.files()).map((file) => [file.path, file.fingerprint])
    );
    const moved: string[] = [];
    const gone: string[] = [];
    for (const path of untrack(() => Object.keys(this.diffs))) {
      const fingerprint = next.get(path);
      // A read already in flight will land on its own.
      if (fingerprint === undefined) {
        gone.push(path);
      } else if (
        fingerprint !== held.get(path) &&
        untrack(() => this.diffs[path])?.kind !== "loading"
      ) {
        moved.push(path);
      }
    }
    for (const path of gone) {
      this.setDiffs((draft) => {
        delete draft[path];
      });
      this.setOpened((draft) => {
        delete draft[path];
      });
    }
    return moved;
  }

  /** Leaves the hunks on screen until the new ones land. */
  private async read(path: string): Promise<void> {
    const mine = this.generation;
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
        draft[path] = { kind: "error", message: (error as Error).message };
      });
    }
  }

  public reset(): void {
    this.generation += 1;
    this.forget();
    this.setFiles([]);
    this.setState((draft) => {
      draft.added = 0;
      draft.removed = 0;
      draft.truncated = false;
      draft.status = "idle";
      draft.error = undefined;
      draft.message = "";
      draft.failure = undefined;
      draft.committed = undefined;
    });
  }

  public setMessage(message: string): void {
    this.setState((draft) => {
      draft.message = message;
    });
  }

  public forgetCommit(): void {
    this.setState((draft) => {
      draft.committed = undefined;
    });
  }

  public async commit(paths: readonly string[]): Promise<void> {
    if (untrack(() => this.state.committing)) {
      return;
    }
    this.setState((draft) => {
      draft.committing = true;
      draft.failure = undefined;
      draft.committed = undefined;
    });
    try {
      const message = untrack(() => this.state.message);
      const sha = await this.enqueue(() => this.session.commit(message, paths));
      this.setState((draft) => {
        draft.committing = false;
        draft.message = "";
        draft.committed = sha;
      });
      await this.refresh();
    } catch (error) {
      this.setState((draft) => {
        draft.committing = false;
        draft.failure = (error as Error).message;
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

  public isOpen(path: string): boolean {
    return this.opened[path] === true;
  }

  public toggle(path: string): void {
    const open = !untrack(() => this.opened[path]);
    this.setOpened((draft) => {
      draft[path] = open;
    });
    if (open) {
      void this.expand(path);
    }
  }

  /** Reads a file's hunks once; later calls use the cache. */
  public async expand(path: string): Promise<void> {
    if (untrack(() => this.diffs[path]) !== undefined) {
      return;
    }
    this.setDiffs((draft) => {
      draft[path] = { kind: "loading" };
    });
    await this.read(path);
  }

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
    this.setOpened((draft) => {
      for (const path of Object.keys(draft)) {
        delete draft[path];
      }
    });
  }

  private base(): DiffBase {
    return { kind: untrack(() => this.state.base) };
  }

  /** Serialises requests: the server's `GitMonitor` rejects concurrent operations. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
