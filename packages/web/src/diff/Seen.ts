import { createStore, untrack, type Store, type StoreSetter } from "solid-js";

import type { ChangeSummary } from "#protocol/Diff";

const KEY = "pim.diff.seen";

/** Path → the fingerprint it was ticked at; an edit since gives the row another one. */
type Marks = Record<string, string>;

type SeenState = { marks: Marks };

/** Which changed files a reader has ticked off, remembered per working copy. */
export class Seen {
  public readonly state: Store<SeenState>;
  private readonly setState: StoreSetter<SeenState>;
  private readonly all: Record<string, Marks>;
  private where: string;

  public constructor() {
    this.all = read();
    this.where = "";
    const [state, setState] = createStore<SeenState>({ marks: {} });
    this.state = state;
    this.setState = setState;
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
    this.put(kept);
  }

  public isSeen(file: ChangeSummary): boolean {
    return this.state.marks[file.path] === file.fingerprint;
  }

  /** How many of these rows are ticked at the fingerprint they carry now. */
  public count(files: readonly ChangeSummary[]): number {
    return files.reduce(
      (total, file) => total + (this.isSeen(file) ? 1 : 0),
      0
    );
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

  public markAll(files: readonly ChangeSummary[]): void {
    this.put({ ...this.marks(), ...fingerprints(files) });
  }

  public clear(): void {
    this.put({});
  }

  // The written copy, read synchronously: a store write only lands on the next flush.
  private marks(): Marks {
    return this.all[this.where] ?? {};
  }

  private put(marks: Marks): void {
    if (Object.keys(marks).length === 0) {
      delete this.all[this.where];
    } else {
      this.all[this.where] = marks;
    }
    this.setState((draft) => {
      draft.marks = marks;
    });
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
