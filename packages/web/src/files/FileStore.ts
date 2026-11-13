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
import type { FileContent, FolderListing } from "#protocol/Diff";
import type { SessionStore } from "../session/SessionStore";
import { FileTree, type Folder, type Loaded, type TreeRow } from "./FileTree";

export type FileView =
  | { readonly kind: "loading"; readonly path: string }
  | {
      readonly kind: "ready";
      readonly file: FileContent;
      readonly lines: readonly string[];
    }
  | { readonly kind: "error"; readonly path: string; readonly message: string };

export type FilesState = {
  selected: string | undefined;
  filter: string;
};

export type FileTimings = {
  /** Debounce for re-reading after repo changes. */
  readonly settleMs?: number;
  /** Debounce for asking the server what the filter matches. */
  readonly findMs?: number;
};

const SETTLE_MS = 200;

const FIND_MS = 100;

function viewOf(file: FileContent): FileView {
  return {
    kind: "ready",
    file,
    lines: file.text === undefined ? [] : Lines.split(file.text),
  };
}

function clear(draft: Record<string, unknown>): void {
  for (const key of Object.keys(draft)) {
    delete draft[key];
  }
}

async function settled<T>(pending: Promise<T>): Promise<Loaded<T>> {
  try {
    return { kind: "ready", value: await pending };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

function sameListing(left: FolderListing, right: FolderListing): boolean {
  return (
    (left.truncated === true) === (right.truncated === true) &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, at) => {
      const other = right.entries[at]!;
      return (
        entry.name === other.name &&
        entry.path === other.path &&
        entry.kind === other.kind
      );
    })
  );
}

/** The working tree, listed a folder at a time, the filter's hits, and the one file being read. */
export class FileStore {
  public readonly state: Store<FilesState>;
  private readonly setState: StoreSetter<FilesState>;
  /** Listings by root-relative folder path, `""` for the root. */
  public readonly folders: Store<Record<string, Folder>>;
  private readonly setFolders: StoreSetter<Record<string, Folder>>;
  public readonly rows: Accessor<readonly TreeRow[]>;
  /** The root and every open folder reached from it. */
  private readonly shown: Accessor<readonly string[]>;
  /** What the server matched for the filter; held until the next answer lands. */
  public readonly found: Accessor<Loaded<readonly string[]> | undefined>;
  private readonly setFound: Setter<Loaded<readonly string[]> | undefined>;
  public readonly view: Accessor<FileView | undefined>;
  private readonly setView: Setter<FileView | undefined>;
  private readonly opened: Store<Record<string, boolean>>;
  private readonly setOpened: StoreSetter<Record<string, boolean>>;
  private readonly session: SessionStore;
  private readonly settleMs: number;
  private readonly findMs: number;
  /** The latest request's ticket per `list:<path>`, `find` and `read`. */
  private readonly latest = new Map<string, number>();
  private tickets = 0;
  /** `revision()` when the tree was last read. */
  private synced = "";
  private readonly watching: Accessor<boolean>;
  private readonly setWatching: Setter<boolean>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private findTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(session: SessionStore, timings: FileTimings = {}) {
    this.session = session;
    this.settleMs = timings.settleMs ?? SETTLE_MS;
    this.findMs = timings.findMs ?? FIND_MS;
    const [state, setState] = createStore<FilesState>({
      selected: undefined,
      filter: "",
    });
    const [folders, setFolders] = createStore<Record<string, Folder>>({});
    const [found, setFound] = createSignal<Loaded<readonly string[]>>();
    const [view, setView] = createSignal<FileView>();
    const [opened, setOpened] = createStore<Record<string, boolean>>({});
    const [watching, setWatching] = createSignal(false);
    this.state = state;
    this.setState = setState;
    this.folders = folders;
    this.setFolders = setFolders;
    this.found = found;
    this.setFound = setFound;
    this.view = view;
    this.setView = setView;
    this.opened = opened;
    this.setOpened = setOpened;
    this.watching = watching;
    this.setWatching = setWatching;
    this.rows = createMemo(() =>
      FileTree.rows(folders, (path) => this.isOpen(path))
    );
    this.shown = createMemo(() => [
      "",
      ...this.rows().flatMap((row) =>
        row.kind === "entry" &&
        row.entry.kind === "folder" &&
        this.isOpen(row.entry.path)
          ? [row.entry.path]
          : []
      ),
    ]);

    createEffect(
      () =>
        this.watching()
          ? this.shown().filter((path) => this.folders[path] === undefined)
          : [],
      (unlisted) => {
        for (const path of unlisted) {
          void this.list(path, false);
        }
      }
    );

    createEffect(
      () => this.state.filter.trim(),
      (query) => {
        clearTimeout(this.findTimer);
        this.latest.delete("find");
        if (query === "") {
          this.setFound(undefined);
          return;
        }
        this.findTimer = setTimeout(() => {
          void this.find(query);
        }, this.findMs);
      }
    );

    createEffect(
      () => this.session.state.cwd,
      (cwd, previous) => {
        if (previous !== undefined && cwd !== previous) {
          this.reset();
        }
      }
    );

    createEffect(
      () => this.revision(),
      (revision, previous) => {
        if (previous !== undefined && revision !== previous) {
          this.schedule();
        }
      }
    );
  }

  /** Only a watched store lists folders and re-reads on repo changes. */
  public watch(active: boolean): void {
    this.setWatching(active);
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!active) {
      return;
    }
    if (untrack(() => this.folders[""]) === undefined) {
      this.synced = untrack(() => this.revision());
    } else if (untrack(() => this.revision()) !== this.synced) {
      void this.sync();
    }
  }

  public isOpen(path: string): boolean {
    return this.opened[path] === true;
  }

  public toggle(path: string): void {
    const open = !untrack(() => this.isOpen(path));
    if (open && untrack(() => this.folders[path])?.kind === "error") {
      this.forget([path]);
    }
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

  public select(path: string | undefined): void {
    if (untrack(() => this.state.selected) === path) {
      return;
    }
    this.setState((draft) => {
      draft.selected = path;
    });
    this.setView(path === undefined ? undefined : { kind: "loading", path });
    if (path !== undefined) {
      void this.read(path);
    }
  }

  public reset(): void {
    this.synced = "";
    this.latest.clear();
    this.setView(undefined);
    this.setFolders(clear);
    this.setOpened(clear);
    this.setState((draft) => {
      draft.selected = undefined;
      draft.filter = "";
    });
  }

  private revision(): string {
    const { repoRevision, filesRevision } = this.session.state;
    return `${repoRevision}\0${filesRevision}`;
  }

  private schedule(): void {
    if (!untrack(this.watching)) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync();
    }, this.settleMs);
  }

  private forget(paths: Iterable<string>): void {
    this.setFolders((draft) => {
      for (const path of paths) {
        this.latest.delete(`list:${path}`);
        delete draft[path];
      }
    });
  }

  /** Quiet re-read of the folders on screen, the filter's hits and the open file; each stays until its new one lands. */
  private async sync(): Promise<void> {
    if (untrack(() => this.folders[""]) === undefined) {
      return;
    }
    this.synced = untrack(() => this.revision());
    const shown = new Set(untrack(this.shown));
    this.forget(
      untrack(() => Object.keys(this.folders)).filter(
        (path) => !shown.has(path)
      )
    );
    const selected = untrack(() => this.state.selected);
    const query = untrack(() => this.state.filter.trim());
    await Promise.all([
      ...[...shown].map((path) => this.list(path, true)),
      selected === undefined ? undefined : this.read(selected),
      query === "" ? undefined : this.find(query),
    ]);
  }

  /** Makes this request the latest for `key`; the check answers whether it still is. */
  private claim(key: string): () => boolean {
    const ticket = ++this.tickets;
    this.latest.set(key, ticket);
    return () => this.latest.get(key) === ticket;
  }

  private async list(path: string, quiet: boolean): Promise<void> {
    const latest = this.claim(`list:${path}`);
    if (!quiet) {
      this.setFolders((draft) => {
        draft[path] = { kind: "loading" };
      });
    }
    const folder = await settled(this.session.listFolder(path));
    const held = untrack(() => this.folders[path]);
    if (
      !latest() ||
      (folder.kind === "ready" &&
        held?.kind === "ready" &&
        sameListing(folder.value, held.value))
    ) {
      return;
    }
    this.setFolders((draft) => {
      draft[path] = folder;
    });
  }

  private async find(query: string): Promise<void> {
    const latest = this.claim("find");
    const found = await settled(
      this.session.findFiles(query).then((files) => files.paths)
    );
    if (latest()) {
      this.setFound(found);
    }
  }

  private async read(path: string): Promise<void> {
    const latest = this.claim("read");
    const current = (): boolean =>
      latest() && untrack(() => this.state.selected) === path;
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
