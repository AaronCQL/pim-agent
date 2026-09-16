import { join } from "node:path";

import { Fs } from "../shared/Fs";
import { Json } from "../shared/Json";
import { Paths } from "../shared/Paths";

export type SessionEntry = {
  readonly archived?: boolean;
  /** Sticky: set by hand, and only a read clears it. */
  readonly unread?: boolean;
};

export type ProjectEntry = {
  readonly pinned?: boolean;
  /** The sidebar group stands unfolded; absent is folded, which is where a project starts. */
  readonly expanded?: boolean;
};

/** The pin flags and the order they are shown in, from one read of the file. */
export type Pinning = {
  /** Keyed by absolute cwd. */
  readonly projects: ReadonlyMap<string, ProjectEntry>;
  /** The pinned directories, in the order they are shown. */
  readonly order: readonly string[];
};

type Stored = {
  readonly version: 1;
  readonly sessions: Record<string, SessionEntry>;
  readonly projects: Record<string, ProjectEntry>;
  /**
   * Where the pinned directories sort, and only that: `projects` stays the
   * truth of whether one is pinned. An entry here that is not pinned is
   * ignored and a pin it has never heard of still sorts, so a file written by
   * a pim that predates the order — or by one that does not write it — needs
   * no migration.
   */
  readonly pins: readonly string[];
};

type Loaded = {
  readonly sessions: Map<string, SessionEntry>;
  readonly projects: Map<string, ProjectEntry>;
  pins: string[];
};

const NONE: SessionEntry = {};

/** Per-session and per-project overrides, shared by every surface on a machine. */
export class SessionMeta {
  private readonly file: string;
  private readonly writes = Fs.serialised();

  /** Defaults to `~/.pim/sessions.json`. */
  public constructor(path?: string) {
    this.file = path ?? join(Paths.pimHomeDir(), "sessions.json");
  }

  public async of(sessionId: string): Promise<SessionEntry> {
    return (await this.sessions()).get(sessionId) ?? NONE;
  }

  /** One read for a whole listing; `of` per row is one read per row. */
  public async sessions(): Promise<ReadonlyMap<string, SessionEntry>> {
    return (await this.read()).sessions;
  }

  /** The pinned directories in display order; a listing wants both halves, and this is one read for them. */
  public async pinning(): Promise<Pinning> {
    const loaded = await this.read();
    return { projects: loaded.projects, order: ordered(loaded) };
  }

  /** The pinned directories in display order. */
  public async pins(): Promise<readonly string[]> {
    return ordered(await this.read());
  }

  public setArchived(sessionId: string, archived: boolean): Promise<void> {
    return this.mutate((loaded) =>
      put(loaded.sessions, sessionId, { archived })
    );
  }

  public setUnread(sessionId: string, unread: boolean): Promise<void> {
    return this.mutate((loaded) => put(loaded.sessions, sessionId, { unread }));
  }

  /** A new pin goes to the top, where you have just put it; an old one leaves the order with the flag. */
  public setPinned(cwd: string, pinned: boolean): Promise<void> {
    return this.mutate((loaded) => {
      const at = loaded.pins.indexOf(cwd);
      if (at !== -1) {
        loaded.pins.splice(at, 1);
      }
      if (pinned) {
        loaded.pins.unshift(cwd);
      }
      return put(loaded.projects, cwd, { pinned });
    });
  }

  /**
   * Folds a project's group, or unfolds it. Kept beside the pin rather than
   * in the browser, so the fold a phone made is the fold a desktop opens to.
   */
  public setExpanded(cwd: string, expanded: boolean): Promise<void> {
    return this.mutate((loaded) => put(loaded.projects, cwd, { expanded }));
  }

  /** Takes the whole order rather than a move, so two surfaces settle on the last one written. */
  public setPinOrder(order: readonly string[]): Promise<void> {
    return this.mutate((loaded) => {
      loaded.pins = [...new Set(order)].filter(
        (cwd) => loaded.projects.get(cwd)?.pinned === true
      );
      return true;
    });
  }

  /** Drops the sessions that are gone; a pin outlives every session of its project. */
  public prune(alive: ReadonlySet<string>): Promise<void> {
    return this.mutate((loaded) => {
      let dropped = false;
      for (const sessionId of loaded.sessions.keys()) {
        if (!alive.has(sessionId)) {
          loaded.sessions.delete(sessionId);
          dropped = true;
        }
      }
      return dropped;
    });
  }

  /** Settles the writes taken so far, for a clean stop. */
  public async flush(): Promise<void> {
    await this.writes.run(async () => undefined);
  }

  private async read(): Promise<Loaded> {
    const raw = Json.asRecord(
      await Fs.readJsonOr<unknown>(this.file, undefined)
    );
    if (raw?.version !== 1) {
      return { sessions: new Map(), projects: new Map(), pins: [] };
    }
    return {
      sessions: parseAll(raw.sessions, parseSession),
      projects: parseAll(raw.projects, parseProject),
      pins: Array.isArray(raw.pins)
        ? raw.pins.filter((cwd) => typeof cwd === "string")
        : [],
    };
  }

  /** Re-reads under the lock, so a write by another process survives this one. */
  private async mutate(update: (loaded: Loaded) => boolean): Promise<void> {
    await this.writes.run(async () => {
      const loaded = await this.read();
      if (!update(loaded)) {
        return;
      }
      await Paths.ensurePimHome();
      await Fs.writeJson(this.file, {
        version: 1,
        sessions: Object.fromEntries(loaded.sessions),
        projects: Object.fromEntries(loaded.projects),
        pins: loaded.pins,
      } satisfies Stored);
    });
  }
}

/**
 * The pinned directories in display order: the ones the stored order names,
 * then any pin it has not heard of, by path. A duplicate in the order is
 * taken once, at the first place it appears.
 */
function ordered({ projects, pins }: Loaded): readonly string[] {
  const unplaced = new Set(
    [...projects]
      .filter(([, entry]) => entry.pinned === true)
      .map(([cwd]) => cwd)
  );
  const listed = pins.filter((cwd) => unplaced.delete(cwd));
  return [...listed, ...[...unplaced].sort()];
}

function put<T extends object>(
  into: Map<string, T>,
  key: string,
  patch: T
): boolean {
  const next = onlySet({ ...into.get(key), ...patch });
  if (Object.keys(next).length === 0) {
    into.delete(key);
  } else {
    into.set(key, next);
  }
  return true;
}

/** Every field is an opt-in flag, so a false one is the same as an absent one. */
function onlySet<T extends object>(entry: T): T {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value === true)
  ) as T;
}

function parseAll<T>(
  value: unknown,
  parse: (value: unknown) => T | undefined
): Map<string, T> {
  const parsed = new Map<string, T>();
  for (const [key, entry] of Object.entries(Json.asRecord(value) ?? {})) {
    const valid = parse(entry);
    if (valid !== undefined) {
      parsed.set(key, valid);
    }
  }
  return parsed;
}

function parseSession(value: unknown): SessionEntry | undefined {
  const raw = Json.asRecord(value);
  if (raw === undefined || !isFlag(raw.archived) || !isFlag(raw.unread)) {
    return undefined;
  }
  return onlySet({ archived: raw.archived, unread: raw.unread });
}

function parseProject(value: unknown): ProjectEntry | undefined {
  const raw = Json.asRecord(value);
  if (raw === undefined || !isFlag(raw.pinned) || !isFlag(raw.expanded)) {
    return undefined;
  }
  return onlySet({ pinned: raw.pinned, expanded: raw.expanded });
}

function isFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}
