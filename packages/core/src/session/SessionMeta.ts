import { join } from "node:path";

import { Fs } from "../shared/Fs";
import { Json } from "../shared/Json";
import { Paths } from "../shared/Paths";

export type SessionEntry = {
  readonly archived?: boolean;
  /** Set by hand; only a read clears it. */
  readonly unread?: boolean;
};

export type ProjectEntry = {
  readonly pinned?: boolean;
  /** Absent means folded. */
  readonly expanded?: boolean;
  /** Display name instead of the directory's base name. */
  readonly label?: string;
};

export type Pinning = {
  /** Keyed by absolute cwd. */
  readonly projects: ReadonlyMap<string, ProjectEntry>;
  /** Pinned cwds in display order. */
  readonly order: readonly string[];
};

type Stored = {
  readonly version: 1;
  readonly sessions: Record<string, SessionEntry>;
  readonly projects: Record<string, ProjectEntry>;
  /** Sort order only; `projects` decides what is pinned. */
  readonly pins: readonly string[];
};

type Loaded = {
  readonly sessions: Map<string, SessionEntry>;
  readonly projects: Map<string, ProjectEntry>;
  pins: string[];
};

const NONE: SessionEntry = {};

/** Per-session and per-project UI state, shared by every surface on the machine. */
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

  /** One file read for the whole listing. */
  public async sessions(): Promise<ReadonlyMap<string, SessionEntry>> {
    return (await this.read()).sessions;
  }

  public async pinning(): Promise<Pinning> {
    const loaded = await this.read();
    return { projects: loaded.projects, order: ordered(loaded) };
  }

  /** Pinned cwds in display order. */
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

  /** A new pin goes to the top. */
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

  public setExpanded(cwd: string, expanded: boolean): Promise<void> {
    return this.mutate((loaded) => put(loaded.projects, cwd, { expanded }));
  }

  /** `null` restores the base name. */
  public setLabel(cwd: string, label: string | null): Promise<void> {
    return this.mutate((loaded) =>
      put(loaded.projects, cwd, { label: label ?? "" })
    );
  }

  /** Replaces the whole order; unpinned and duplicate cwds are dropped. */
  public setPinOrder(order: readonly string[]): Promise<void> {
    return this.mutate((loaded) => {
      loaded.pins = [...new Set(order)].filter(
        (cwd) => loaded.projects.get(cwd)?.pinned === true
      );
      return true;
    });
  }

  /** Drops entries for sessions not in `alive`. Projects are kept. */
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

  /** Waits for pending writes. */
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

  /** Re-reads under the lock so another process's write is not lost. */
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

/** Stored order first, then pins missing from it sorted by path. */
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

/** Drops `false` and `""` fields; they mean the same as absent. */
function onlySet<T extends object>(entry: T): T {
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([, value]) =>
        value === true || (typeof value === "string" && value !== "")
    )
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
  if (
    raw === undefined ||
    !isFlag(raw.pinned) ||
    !isFlag(raw.expanded) ||
    !isName(raw.label)
  ) {
    return undefined;
  }
  return onlySet({
    pinned: raw.pinned,
    expanded: raw.expanded,
    label: raw.label,
  });
}

function isFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isName(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
