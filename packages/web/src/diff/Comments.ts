import {
  createContext,
  createSignal,
  createStore,
  type Accessor,
  type Setter,
  type Store,
  type StoreSetter,
} from "solid-js";

const KEY = "pim.diff.comments";

export type CommentSide = "old" | "new";

export type Comment = {
  readonly id: string;
  readonly path: string;
  /** Absent for a comment on the file rather than any line of it. */
  readonly side?: CommentSide;
  readonly start?: number;
  readonly end?: number;
  /** The first line as it read when written; what survives a renumbering. */
  readonly quote?: string;
  /** The file's `fingerprint` when written; a change makes the comment outdated. */
  readonly fingerprint: string;
  readonly text: string;
  readonly createdAt: number;
};

/** What a new comment is made against: one line of one side, or the file itself. */
export type CommentAnchor = {
  readonly path: string;
  readonly fingerprint: string;
  readonly side?: CommentSide;
  readonly line?: number;
  readonly quote?: string;
};

const NONE: readonly Comment[] = [];

/** What a reader has written against a working copy's changes, kept in this browser. */
export class Comments {
  /** Per path, so a row tracks its own file's comments and no other row's. */
  private readonly lists: Store<Record<string, readonly Comment[]>>;
  private readonly setLists: StoreSetter<Record<string, readonly Comment[]>>;
  private readonly counts: Store<Record<string, number>>;
  private readonly setCounts: StoreSetter<Record<string, number>>;
  /** Per anchored line: a long diff would otherwise put a reader on one list per row. */
  private readonly anchors: Store<Record<string, readonly Comment[]>>;
  private readonly setAnchors: StoreSetter<Record<string, readonly Comment[]>>;
  private readonly everything: Accessor<readonly Comment[]>;
  private readonly setEverything: Setter<readonly Comment[]>;
  private readonly held: Record<string, readonly Comment[]>;
  private where: string;
  private sequence: number;
  private writing: boolean;

  public constructor() {
    this.held = read();
    this.where = "";
    this.sequence = 0;
    this.writing = false;
    const [lists, setLists] = createStore<Record<string, readonly Comment[]>>(
      {}
    );
    const [counts, setCounts] = createStore<Record<string, number>>({});
    const [anchors, setAnchors] = createStore<
      Record<string, readonly Comment[]>
    >({});
    const [everything, setEverything] = createSignal<readonly Comment[]>(NONE);
    this.lists = lists;
    this.setLists = setLists;
    this.counts = counts;
    this.setCounts = setCounts;
    this.anchors = anchors;
    this.setAnchors = setAnchors;
    this.everything = everything;
    this.setEverything = setEverything;
  }

  /** Adopts a working copy's comments; nothing is ever forgotten on the way. */
  public load(cwd: string): void {
    if (this.where === cwd) {
      return;
    }
    this.where = cwd;
    this.publish(this.held[cwd] ?? NONE);
  }

  public list(path: string): readonly Comment[] {
    return this.lists[path] ?? NONE;
  }

  public count(path: string): number {
    return this.counts[path] ?? 0;
  }

  /** The comments anchored to one line of one side, in the order they were written. */
  public at(path: string, side: CommentSide, line: number): readonly Comment[] {
    return this.anchors[anchorKey(path, side, line)] ?? NONE;
  }

  /** Every comment on this working copy, in the order they were written. */
  public all(): readonly Comment[] {
    return this.everything();
  }

  /** Starts an empty comment and answers with its id, which is what edits it. */
  public open(anchor: CommentAnchor): string {
    const now = Date.now();
    this.sequence += 1;
    const line =
      anchor.side === undefined || anchor.line === undefined
        ? {}
        : { side: anchor.side, start: anchor.line, end: anchor.line };
    const comment: Comment = {
      id: `${now.toString(36)}-${this.sequence.toString(36)}`,
      path: anchor.path,
      fingerprint: anchor.fingerprint,
      quote: anchor.quote,
      text: "",
      createdAt: now,
      ...line,
    };
    this.mutate((list) => [...list, comment]);
    return comment.id;
  }

  public write(id: string, text: string): void {
    this.mutate((list) =>
      list.map((comment) =>
        comment.id === id && comment.text !== text
          ? { ...comment, text }
          : comment
      )
    );
  }

  /** Widens a line comment's range to take in another line of the same side. */
  public extend(id: string, line: number): void {
    this.mutate((list) =>
      list.map((comment) =>
        comment.id === id &&
        comment.start !== undefined &&
        comment.end !== undefined
          ? {
              ...comment,
              start: Math.min(comment.start, line),
              end: Math.max(comment.end, line),
            }
          : comment
      )
    );
  }

  public remove(id: string): void {
    this.mutate((list) => list.filter((comment) => comment.id !== id));
  }

  public clear(): void {
    this.mutate(() => NONE);
  }

  private mutate(
    change: (list: readonly Comment[]) => readonly Comment[]
  ): void {
    const current = this.held[this.where] ?? NONE;
    const next = change(current);
    if (same(current, next)) {
      return;
    }
    if (next.length === 0) {
      delete this.held[this.where];
    } else {
      this.held[this.where] = next;
    }
    this.publish(next);
    this.persist();
  }

  private publish(list: readonly Comment[]): void {
    const byPath = group(list, (comment) => comment.path);
    this.setEverything(list);
    this.setLists((draft) => {
      sync(draft, byPath, same);
    });
    this.setCounts((draft) => {
      sync(
        draft,
        new Map([...byPath].map(([path, held]) => [path, held.length])),
        (left, right) => left === right
      );
    });
    this.setAnchors((draft) => {
      sync(draft, group(list.filter(anchored), lineKey), same);
    });
  }

  // One write a tick: a keystroke is a write, and a typist makes many of them.
  private persist(): void {
    if (this.writing) {
      return;
    }
    this.writing = true;
    queueMicrotask(() => {
      this.writing = false;
      try {
        localStorage.setItem(KEY, JSON.stringify(this.held));
      } catch {
        // Private mode or a full quota; the comments still hold for this tab.
      }
    });
  }
}

/** The comments the shell holds; absent wherever a diff is painted with no gutter to tap. */
export const ReviewComments = createContext<() => Comments | undefined>(
  () => undefined
);

function anchorKey(path: string, side: CommentSide, line: number): string {
  return `${path}\n${side}:${line}`;
}

function anchored(comment: Comment): boolean {
  return comment.side !== undefined && comment.start !== undefined;
}

function lineKey(comment: Comment): string {
  return anchorKey(comment.path, comment.side ?? "new", comment.start ?? 0);
}

function group(
  list: readonly Comment[],
  keyOf: (comment: Comment) => string
): ReadonlyMap<string, readonly Comment[]> {
  const groups = new Map<string, Comment[]>();
  for (const comment of list) {
    const key = keyOf(comment);
    const held = groups.get(key);
    if (held === undefined) {
      groups.set(key, [comment]);
    } else {
      held.push(comment);
    }
  }
  return groups;
}

// Only the keys whose answer moved are written, so one comment wakes one row.
function sync<T>(
  draft: Record<string, T>,
  next: ReadonlyMap<string, T>,
  equal: (left: T | undefined, right: T) => boolean
): void {
  for (const key of Object.keys(draft)) {
    if (!next.has(key)) {
      delete draft[key];
    }
  }
  for (const [key, value] of next) {
    if (!equal(draft[key], value)) {
      draft[key] = value;
    }
  }
}

function same(
  left: readonly Comment[] | undefined,
  right: readonly Comment[]
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((comment, at) => comment === right[at])
  );
}

function read(): Record<string, readonly Comment[]> {
  try {
    const held: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof held !== "object" || held === null) {
      return {};
    }
    const kept: Record<string, readonly Comment[]> = {};
    for (const [cwd, list] of Object.entries(held)) {
      if (Array.isArray(list)) {
        kept[cwd] = list.filter(isComment);
      }
    }
    return kept;
  } catch {
    return {};
  }
}

function isComment(value: unknown): value is Comment {
  const comment = value as Partial<Comment> | null;
  return (
    typeof comment?.id === "string" &&
    typeof comment.path === "string" &&
    typeof comment.text === "string"
  );
}
