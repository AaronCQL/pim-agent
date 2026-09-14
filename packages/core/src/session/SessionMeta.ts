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
};

type Stored = {
  readonly version: 1;
  readonly sessions: Record<string, SessionEntry>;
  readonly projects: Record<string, ProjectEntry>;
};

type Loaded = {
  readonly sessions: Map<string, SessionEntry>;
  readonly projects: Map<string, ProjectEntry>;
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

  /** Keyed by absolute cwd. */
  public async projects(): Promise<ReadonlyMap<string, ProjectEntry>> {
    return (await this.read()).projects;
  }

  public setArchived(sessionId: string, archived: boolean): Promise<void> {
    return this.mutate((loaded) =>
      put(loaded.sessions, sessionId, { archived })
    );
  }

  public setUnread(sessionId: string, unread: boolean): Promise<void> {
    return this.mutate((loaded) => put(loaded.sessions, sessionId, { unread }));
  }

  public setPinned(cwd: string, pinned: boolean): Promise<void> {
    return this.mutate((loaded) => put(loaded.projects, cwd, { pinned }));
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
      return { sessions: new Map(), projects: new Map() };
    }
    return {
      sessions: parseAll(raw.sessions, parseSession),
      projects: parseAll(raw.projects, parseProject),
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
      } satisfies Stored);
    });
  }
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
  if (raw === undefined || !isFlag(raw.pinned)) {
    return undefined;
  }
  return onlySet({ pinned: raw.pinned });
}

function isFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}
