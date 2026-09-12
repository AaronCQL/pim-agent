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

const KEY = "pim.diff.picked";
const SEEN = "pim.diff.seen";

/** Path → the fingerprint it was picked at; an edit since gives the row another one. */
type Marks = Record<string, string>;

/** Which changed files a reader has picked for the commit, remembered per working copy. */
export class Picked {
  /** Flat, and written key by key: a row tracks its own path and no other row's. */
  public readonly state: Store<Marks>;
  private readonly setState: StoreSetter<Marks>;
  /** How many are picked, carried rather than counted: a reduce over the list would make every row a source of the header. */
  private readonly picked: Accessor<number>;
  private readonly setPicked: Setter<number>;
  private readonly all: Record<string, Marks>;
  private where: string;

  public constructor() {
    this.all = read();
    this.where = "";
    const [state, setState] = createStore<Marks>({});
    const [picked, setPicked] = createSignal(0);
    this.state = state;
    this.setState = setState;
    this.picked = picked;
    this.setPicked = setPicked;
  }

  /** Adopts a working copy's picks, forgetting every path this list no longer names. */
  public load(cwd: string, files: readonly ChangeSummary[]): void {
    const held = this.all[cwd] ?? {};
    const listed = fingerprints(files);
    const kept: Marks = {};
    for (const path of Object.keys(listed)) {
      const mark = held[path];
      if (mark !== undefined) {
        kept[path] = mark;
      }
    }
    this.where = cwd;
    this.put(kept);
  }

  public isPicked(file: ChangeSummary): boolean {
    return this.state[file.path] === file.fingerprint;
  }

  public count(): number {
    return this.picked();
  }

  public toggle(file: ChangeSummary): void {
    const [path, fingerprint] = untrack(
      () => [file.path, file.fingerprint] as const
    );
    const next = { ...this.marks() };
    if (next[path] === fingerprint) {
      delete next[path];
    } else {
      next[path] = fingerprint;
    }
    this.put(next);
  }

  public pickAll(files: readonly ChangeSummary[]): void {
    this.put(fingerprints(files));
  }

  public clear(): void {
    this.put({});
  }

  // The written copy, read synchronously: a store write only lands on the next flush.
  private marks(): Marks {
    return this.all[this.where] ?? {};
  }

  private put(marks: Marks): void {
    const paths = Object.keys(marks);
    if (paths.length === 0) {
      delete this.all[this.where];
    } else {
      this.all[this.where] = marks;
    }
    this.setPicked(paths.length);
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
    try {
      localStorage.setItem(KEY, JSON.stringify(this.all));
    } catch {
      // Private mode or a full quota; the picks still hold for this overlay.
    }
  }
}

function read(): Record<string, Marks> {
  try {
    localStorage.removeItem(SEEN);
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
