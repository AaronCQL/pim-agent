import { untrack, type Store, type StoreSetter } from "solid-js";

import { openingMessage } from "./fold";
import type { SessionState } from "./SessionStore";

/**
 * A session this client made and the server has not written a line of yet, so
 * it exists in the gateway's memory and nowhere else: the sessions directory
 * cannot list it, which is why the sidebar is handed it separately.
 */
export type Unwritten = {
  readonly sessionId: string;
  readonly cwd: string;
  /**
   * A message has gone out, so it is a conversation now and only the listing
   * is behind. The row stays until the directory can answer for it, but a new
   * chat asked for from here is a new session rather than a return to this
   * one.
   */
  readonly sent: boolean;
};

/**
 * The unwritten session as the sidebar paints it: one row the listing has no
 * answer for. Untitled here like every other row, because a row is named by
 * `localTitle` whichever source drew it.
 */
export type UnwrittenSummary = {
  readonly sessionId: string;
  readonly cwd: string;
};

/**
 * Where the unsent messages and the id of the unwritten session live across a
 * reload. Local to this browser deliberately, unlike the read cursor: an
 * unsent message is not part of the conversation, and no other client has any
 * business seeing it.
 */
const DRAFTS_KEY = "pim.drafts";
const UNWRITTEN_KEY = "pim.unwritten";

/**
 * The unsent messages and the session that has nothing but them: the
 * synchronous mirror a keystroke writes, what the sidebar calls a row the
 * listing cannot name yet, and the coalesced writes to `localStorage`.
 */
export class Drafts {
  private readonly state: Store<SessionState>;
  private readonly setState: StoreSetter<SessionState>;
  /**
   * The unsent messages, synchronously. The store copy is the same strings,
   * but a keystroke writes it before anything reads it back, so the
   * persisted value is taken from here.
   */
  private readonly drafts: Record<string, string>;
  /**
   * Pending `localStorage` writes, one per key. A draft moves far faster
   * than a reload can read it — once per keystroke — and `localStorage` is
   * synchronous disk, so the writes are coalesced onto the next microtask:
   * what a reload needs is where a value ended up, not each place it passed
   * through.
   */
  private readonly writes = new Map<string, () => string | undefined>();
  /**
   * The unsent message waiting for a session to belong to, held while an
   * attach for a *new* chat is in flight. Id and cwd are the server's to
   * assign, so the draft is recorded where they arrive — the `attached`
   * frame — rather than read back out of a store that settles its writes on
   * its own schedule.
   */
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

  /**
   * The row the server's listing cannot produce, for a session whose first
   * line has not reached disk yet.
   *
   * A new chat nobody has typed into yet gets no row at all: an empty
   * composer is not a conversation, and a row for it would be the sidebar
   * listing the button that made it.
   */
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

  /**
   * What a session is called when the listing has no name for it: a session
   * is its opening message, and one that has not been sent yet is the message
   * about to open it. Never the other way round — a second message being
   * typed into a conversation does not rename it.
   *
   * The same rule the listing uses, which is why the two agree the moment pi
   * writes the log: what this covers is the gap before it does, where the row
   * would otherwise fall back to an id it already had a name for.
   */
  public localTitle(sessionId: string): string | undefined {
    const opening =
      sessionId === this.state.sessionId
        ? this.firstUserText()
        : // A session left behind by a switch has no transcript here, so what
          // it was opened with is only known if this browser is what opened
          // it — which, for the whole of the gap this covers, it is.
          this.state.openings[sessionId];
    const title = opening?.trim() || this.draftText(sessionId).trim();
    return title === "" ? undefined : title;
  }

  /** The unsent message typed into a session; empty when there is none. */
  public draftText(sessionId: string): string {
    return this.state.drafts[sessionId] ?? "";
  }

  /**
   * Mirrors the composer's unsent message onto the session it is being typed
   * into. Which session that is, is the store's answer and not the box's:
   * the composer is one box shared by every session.
   */
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
    // An empty draft is no draft, and deleting rather than storing `""` is
    // what keeps this from growing one entry per session ever opened.
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

  /**
   * The message is on its way, so the box it left is empty. An unwritten
   * session keeps its row — nothing else can draw one until pi has written
   * the log — but it is a conversation from here, named by what was sent
   * rather than by what is typed.
   */
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

  /**
   * The message the unwritten session opens with, if it has one. Only the
   * attached session's content is readable here; one left behind by a switch
   * has nothing but what was typed into it.
   */
  public openingText(unwritten: Unwritten): string | undefined {
    return unwritten.sessionId === this.state.sessionId
      ? this.firstUserText()
      : undefined;
  }

  public setUnwritten(unwritten: Unwritten | undefined): void {
    this.setState((state) => {
      state.unwritten = unwritten;
    });
    // Written from the value just set rather than read back at flush time:
    // a store write lands on its own schedule, and storage must not be told
    // what state was before it did.
    const written =
      unwritten === undefined ? undefined : JSON.stringify(unwritten);
    this.persist(UNWRITTEN_KEY, () => written);
  }

  /**
   * The server has named the chat this browser asked for, so the message
   * typed into it now has somewhere to live.
   */
  public claim(sessionId: string, cwd: string): void {
    if (this.claimed === undefined) {
      return;
    }
    this.setUnwritten({ sessionId, cwd, sent: false });
    this.putDraft(sessionId, this.claimed);
    this.claimed = undefined;
  }

  /**
   * Empties a session's box and answers with what was in it, read from the
   * synchronous copy rather than from the store: a keystroke and the click
   * that carries it elsewhere can land in the same task, and `state` settles
   * one microtask later — long enough to carry away an empty string and then
   * delete the words it stood for.
   */
  public takeDraft(sessionId: string): string {
    const typed = this.drafts[sessionId] ?? "";
    this.putDraft(sessionId, "");
    return typed;
  }

  private firstUserText(): string | undefined {
    return openingMessage(this.state.durable, this.state.optimistic);
  }

  /**
   * Queues one key's write. The value is a thunk so a caller whose value is
   * expensive — the read cursor, re-serialised once per replayed event —
   * pays for the write that actually happens rather than for each one
   * coalesced away. `undefined` removes the key.
   */
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
          // Private mode, a full quota, or no storage at all. Both of these
          // are niceties: a draft and a session id that survive a reload.
        }
      }
    });
  }
}

export function readDrafts(): Record<string, string> {
  return readRecord<string>(DRAFTS_KEY);
}

/** Anything storage has none of, or has nonsense in, reads as empty. */
function readRecord<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, T>);
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
