import {
  createSignal,
  createStore,
  untrack,
  type Accessor,
  type Setter,
  type Store,
  type StoreSetter,
} from "solid-js";

import type { ChangeSummary } from "#protocol/Diff";

const KEY = "pim.diff.seen";

/** Path → the fingerprint it was ticked at; an edit since gives the row another one. */
type Marks = Record<string, string>;

/** Which changed files a reader has ticked off, remembered per working copy. */
export class Seen {
  /** Flat, and written key by key: a row tracks its own path and no other row's. */
  public readonly state: Store<Marks>;
  private readonly setState: StoreSetter<Marks>;
  private readonly all: Record<string, Marks>;
  private readonly ticked: Accessor<number>;
  private readonly setTicked: Setter<number>;
  private where: string;

  public constructor() {
    this.all = read();
    this.where = "";
    const [state, setState] = createStore<Marks>({});
    const [ticked, setTicked] = createSignal(0);
    this.state = state;
    this.setState = setState;
    this.ticked = ticked;
    this.setTicked = setTicked;
  }

  /** Adopts a working copy's ticks, forgetting every path this list no longer names. */
  public load(cwd: string, files: readonly ChangeSummary[]): void {
    const held = this.all[cwd] ?? {};
    const listed = fingerprints(files);
    const kept: Marks = {};
    for (const path of Object.keys(listed)) {
      const ticked = held[path];
      if (ticked !== undefined) {
        kept[path] = ticked;
      }
    }
    this.where = cwd;
    this.put(
      kept,
      Object.keys(kept).filter((path) => kept[path] === listed[path]).length
    );
  }

  public isSeen(file: ChangeSummary): boolean {
    return this.state[file.path] === file.fingerprint;
  }

  /** How many rows of the list last loaded are ticked at the fingerprint they carry now. */
  public count(): number {
    return this.ticked();
  }

  public toggle(file: ChangeSummary): void {
    const [path, fingerprint] = untrack(
      () => [file.path, file.fingerprint] as const
    );
    const next = { ...this.marks() };
    const off = next[path] === fingerprint;
    if (off) {
      delete next[path];
    } else {
      next[path] = fingerprint;
    }
    this.put(next, untrack(this.ticked) + (off ? -1 : 1));
  }

  public markAll(files: readonly ChangeSummary[]): void {
    const listed = fingerprints(files);
    this.put({ ...this.marks(), ...listed }, Object.keys(listed).length);
  }

  public clear(): void {
    this.put({}, 0);
  }

  // The written copy, read synchronously: a store write only lands on the next flush.
  private marks(): Marks {
    return this.all[this.where] ?? {};
  }

  private put(marks: Marks, ticked: number): void {
    if (Object.keys(marks).length === 0) {
      delete this.all[this.where];
    } else {
      this.all[this.where] = marks;
    }
    this.setState((draft) => {
      for (const path of Object.keys(draft)) {
        if (marks[path] === undefined) {
          delete draft[path];
        }
      }
      for (const [path, fingerprint] of Object.entries(marks)) {
        if (draft[path] !== fingerprint) {
          draft[path] = fingerprint;
        }
      }
    });
    this.setTicked(ticked);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.all));
    } catch {
      // Private mode or a full quota; the ticks still hold for this overlay.
    }
  }
}

function read(): Record<string, Marks> {
  try {
    const held: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return typeof held === "object" && held !== null
      ? (held as Record<string, Marks>)
      : {};
  } catch {
    return {};
  }
}

// A snapshot: every writer is called from an event or an effect, where a read
// of the list tracks nothing and Solid says so.
function fingerprints(files: readonly ChangeSummary[]): Marks {
  return untrack(() =>
    Object.fromEntries(files.map((file) => [file.path, file.fingerprint]))
  );
}
