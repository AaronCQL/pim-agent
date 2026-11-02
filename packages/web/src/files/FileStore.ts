import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  untrack,
  type Accessor,
  type Setter,
  type Store,
  type StoreSetter,
} from "solid-js";

import { Lines } from "#core/shared/Lines";
import type { FileContent } from "#protocol/Diff";
import type { SessionStore } from "../session/SessionStore";
import { FileTree, type TreeNode } from "./FileTree";

export type FileView =
  | { readonly kind: "loading"; readonly path: string }
  | {
      readonly kind: "ready";
      readonly file: FileContent;
      readonly lines: readonly string[];
    }
  | { readonly kind: "error"; readonly path: string; readonly message: string };

export type FilesState = {
  /** `ready` only once a list has landed. */
  status: "idle" | "loading" | "ready";
  error: string | undefined;
  truncated: boolean;
  selected: string | undefined;
  filter: string;
};

/** Debounce for re-reading after repo changes. */
const SETTLE_MS = 200;

function viewOf(file: FileContent): FileView {
  return {
    kind: "ready",
    file,
    lines: file.text === undefined ? [] : Lines.split(file.text),
  };
}

/** The working tree's file list and the one file being read. */
export class FileStore {
  public readonly state: Store<FilesState>;
  private readonly setState: StoreSetter<FilesState>;
  public readonly paths: Accessor<readonly string[]>;
  private readonly setPaths: Setter<readonly string[]>;
  public readonly tree: Accessor<TreeNode>;
  public readonly view: Accessor<FileView | undefined>;
  private readonly setView: Setter<FileView | undefined>;
  private readonly opened: Store<Record<string, boolean>>;
  private readonly setOpened: StoreSetter<Record<string, boolean>>;
  private readonly session: SessionStore;
  private readonly settleMs: number;
  private generation = 0;
  private reading = 0;
  /** `repoRevision` when the list was last read. */
  private synced = "";
  private watching = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(session: SessionStore, settleMs: number = SETTLE_MS) {
    this.session = session;
    this.settleMs = settleMs;
    const [state, setState] = createStore<FilesState>({
      status: "idle",
      error: undefined,
      truncated: false,
      selected: undefined,
      filter: "",
    });
    const [paths, setPaths] = createSignal<readonly string[]>([]);
    const [view, setView] = createSignal<FileView>();
    const [opened, setOpened] = createStore<Record<string, boolean>>({});
    this.state = state;
    this.setState = setState;
    this.paths = paths;
    this.setPaths = setPaths;
    this.tree = createMemo(() => FileTree.build(paths()));
    this.view = view;
    this.setView = setView;
    this.opened = opened;
    this.setOpened = setOpened;

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

  /** Only a watched store re-reads on repo changes; the first watch reads the list. */
  public watch(active: boolean): void {
    this.watching = active;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!active) {
      return;
    }
    if (untrack(() => this.state.status) === "idle") {
      void this.refresh();
    } else if (untrack(() => this.session.state.repoRevision) !== this.synced) {
      void this.sync();
    }
  }

  public async refresh(): Promise<void> {
    this.setState((draft) => {
      draft.status = "loading";
      draft.error = undefined;
    });
    await this.load();
  }

  public isOpen(path: string): boolean {
    return this.opened[path] === true;
  }

  public toggle(path: string): void {
    const open = !untrack(() => this.opened[path]);
    this.setOpened((draft) => {
      draft[path] = open;
    });
  }

  public setFilter(filter: string): void {
    this.setState((draft) => {
      draft.filter = filter;
    });
  }

  /** Opens the folders above `path` and reads it. */
  public reveal(path: string): void {
    this.setOpened((draft) => {
      for (const folder of FileTree.ancestors(path)) {
        draft[folder] = true;
      }
    });
    this.select(path);
  }

  public select(path: string): void {
    if (untrack(() => this.state.selected) === path) {
      return;
    }
    this.setState((draft) => {
      draft.selected = path;
    });
    this.setView({ kind: "loading", path });
    void this.read(path);
  }

  public reset(): void {
    this.generation += 1;
    this.synced = "";
    this.setPaths([]);
    this.setView(undefined);
    this.setOpened((draft) => {
      for (const path of Object.keys(draft)) {
        delete draft[path];
      }
    });
    this.setState((draft) => {
      draft.status = "idle";
      draft.error = undefined;
      draft.truncated = false;
      draft.selected = undefined;
      draft.filter = "";
    });
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

  /** Quiet re-read of the list and the open file; both stay on screen until the new ones land. */
  private async sync(): Promise<void> {
    if (untrack(() => this.state.status) === "idle") {
      return;
    }
    const selected = untrack(() => this.state.selected);
    await Promise.all([
      this.load(),
      selected === undefined ? undefined : this.read(selected),
    ]);
  }

  private async load(): Promise<void> {
    const mine = this.generation;
    this.synced = untrack(() => this.session.state.repoRevision) ?? "";
    try {
      const list = await this.session.listFiles();
      if (mine !== this.generation) {
        return;
      }
      this.setPaths(list.paths);
      this.setState((draft) => {
        draft.status = "ready";
        draft.error = undefined;
        draft.truncated = list.truncated === true;
      });
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this.setPaths([]);
      this.setState((draft) => {
        draft.status = "ready";
        draft.error = (error as Error).message;
        draft.truncated = false;
      });
    }
  }

  private async read(path: string): Promise<void> {
    const mine = this.generation;
    const ticket = ++this.reading;
    const current = (): boolean =>
      mine === this.generation &&
      ticket === this.reading &&
      untrack(() => this.state.selected) === path;
    try {
      const file = await this.session.readFile(path);
      if (!current()) {
        return;
      }
      const held = untrack(this.view);
      if (
        held?.kind !== "ready" ||
        held.file.path !== path ||
        held.file.fingerprint !== file.fingerprint
      ) {
        this.setView(viewOf(file));
      }
    } catch (error) {
      if (current()) {
        this.setView({
          kind: "error",
          path,
          message: (error as Error).message,
        });
      }
    }
  }
}
