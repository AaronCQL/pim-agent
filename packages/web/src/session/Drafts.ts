import { untrack, type Store, type StoreSetter } from "solid-js";

import { openingMessage } from "./fold";
import type { SessionState } from "./SessionStore";

/** A session this client created that has nothing on disk yet. */
export type Unwritten = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sent: boolean;
};

export type UnwrittenSummary = {
  readonly sessionId: string;
  readonly cwd: string;
};

const DRAFTS_KEY = "pim.drafts";
const UNWRITTEN_KEY = "pim.unwritten";

/** Unsent drafts per session, persisted to localStorage. */
export class Drafts {
  private readonly state: Store<SessionState>;
  private readonly setState: StoreSetter<SessionState>;
  private readonly drafts: Record<string, string>;
  private readonly writes = new Map<string, () => string | undefined>();
  /** Draft text waiting for the `attached` frame to name its session. */
  public claimed: string | undefined;

  public constructor(
    state: Store<SessionState>,
    setState: StoreSetter<SessionState>,
    drafts: Record<string, string>
  ) {
    this.state = state;
    this.setState = setState;
    this.drafts = drafts;
  }

  public unwrittenSummary(): UnwrittenSummary | undefined {
    const unwritten = this.state.unwritten;
    if (!unwritten) {
      return undefined;
    }
    if (!unwritten.sent && this.localTitle(unwritten.sessionId) === undefined) {
      return undefined;
    }
    return { sessionId: unwritten.sessionId, cwd: unwritten.cwd };
  }

  /** The opening message, else the draft. */
  public localTitle(sessionId: string): string | undefined {
    const opening =
      sessionId === this.state.sessionId
        ? this.firstUserText()
        : this.state.openings[sessionId];
    const title = opening?.trim() || this.draftText(sessionId).trim();
    return title === "" ? undefined : title;
  }

  public draftText(sessionId: string): string {
    return this.state.drafts[sessionId] ?? "";
  }

  public setDraftText(text: string): void {
    this.putDraft(
      untrack(() => this.state.sessionId),
      text
    );
  }

  public putDraft(sessionId: string, text: string): void {
    if (sessionId === "" || (this.drafts[sessionId] ?? "") === text) {
      return;
    }
    if (text === "") {
      delete this.drafts[sessionId];
    } else {
      this.drafts[sessionId] = text;
    }
    this.setState((state) => {
      if (text === "") {
        delete state.drafts[sessionId];
      } else {
        state.drafts[sessionId] = text;
      }
    });
    this.persist(DRAFTS_KEY, () => JSON.stringify(this.drafts));
  }

  /** Clears the draft and attachments, and marks the unwritten session as sent. */
  public spendDraft(): void {
    this.putDraft(this.state.sessionId, "");
    const sessionId = this.state.sessionId;
    this.setState((draft) => {
      delete draft.attachments[sessionId];
    });
    const unwritten = this.state.unwritten;
    if (unwritten && unwritten.sessionId === this.state.sessionId) {
      this.setUnwritten({ ...unwritten, sent: true });
    }
  }

  public openingText(unwritten: Unwritten): string | undefined {
    return unwritten.sessionId === this.state.sessionId
      ? this.firstUserText()
      : undefined;
  }

  public setUnwritten(unwritten: Unwritten | undefined): void {
    this.setState((state) => {
      state.unwritten = unwritten;
    });
    // Serialise now; the store write lands later.
    const written =
      unwritten === undefined ? undefined : JSON.stringify(unwritten);
    this.persist(UNWRITTEN_KEY, () => written);
  }

  public claim(sessionId: string, cwd: string): void {
    if (this.claimed === undefined) {
      return;
    }
    this.setUnwritten({ sessionId, cwd, sent: false });
    this.putDraft(sessionId, this.claimed);
    this.claimed = undefined;
  }

  /** Reads the synchronous copy, since `state` settles a microtask later. */
  public takeDraft(sessionId: string): string {
    const typed = this.drafts[sessionId] ?? "";
    this.putDraft(sessionId, "");
    return typed;
  }

  private firstUserText(): string | undefined {
    return openingMessage(this.state.durable, this.state.optimistic);
  }

  private persist(key: string, value: () => string | undefined): void {
    const flushing = this.writes.size > 0;
    this.writes.set(key, value);
    if (flushing) {
      return;
    }
    queueMicrotask(() => {
      const pending = [...this.writes];
      this.writes.clear();
      for (const [name, read] of pending) {
        const written = read();
        try {
          if (written === undefined) {
            localStorage.removeItem(name);
          } else {
            localStorage.setItem(name, written);
          }
        } catch {
          // Storage unavailable or full.
        }
      }
    });
  }
}

export function readDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
  } catch {
    return {};
  }
}

export function readUnwritten(): Unwritten | undefined {
  try {
    const raw = localStorage.getItem(UNWRITTEN_KEY);
    const held = raw === null ? undefined : (JSON.parse(raw) as Unwritten);
    return typeof held?.sessionId === "string" ? held : undefined;
  } catch {
    return undefined;
  }
}
