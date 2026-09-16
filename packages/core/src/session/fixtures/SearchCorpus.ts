import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";

import type { SessionSummary } from "../SessionRegistry";

/**
 * A sessions tree of real pi JSONL, with a vocabulary chosen so every claim in
 * the search plan has something to bite on: an identifier to split
 * (`SessionLease`), a word whose one-edit neighbours are all present and must
 * stay out of its results (`lease` against `least`, `leave`, `please`), a
 * transposition target (`gateway`), a token rare enough to be dropped
 * (`quokka`), and a session old enough to sit outside any page budget.
 */
export type CorpusTurn = {
  readonly role: "user" | "assistant";
  readonly text: string;
};

export type CorpusSession = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly at: string;
  readonly name?: string;
  readonly turns: readonly CorpusTurn[];
};

const PIM = "/home/dev/pim-agent";
const MMORPG = "/home/dev/mmorpg";
const NOTES = "/home/dev/notes";

const SESSIONS: readonly CorpusSession[] = [
  {
    sessionId: "attachment",
    cwd: PIM,
    at: "2026-08-11T09:00:00.000Z",
    turns: [
      {
        role: "user",
        text: "[Image attachment: /tmp/screenshot-1785579467100.png]\nWhy is this row unnamed?",
      },
      {
        role: "assistant",
        text: "Because the digest fell back to the opening message.",
      },
    ],
  },
  {
    sessionId: "lease-turn",
    cwd: PIM,
    at: "2026-08-10T09:00:00.000Z",
    turns: [
      {
        role: "user",
        text: "Who holds the turn lease when both surfaces write to one session file?",
      },
      {
        role: "assistant",
        text: "The SessionLease guards a whole turn, and the lease is handed back on the next idle edge.",
      },
      { role: "assistant", text: "Either way the lease outlasts the socket." },
    ],
  },
  {
    sessionId: "sidebar-rows",
    cwd: PIM,
    at: "2026-08-09T09:00:00.000Z",
    turns: [
      { role: "user", text: "The sidebar keeps stale rows after a rename." },
      {
        role: "assistant",
        text: "Sidebar rows are rebuilt from the digest, so a rename lands on the next announce from the gateway.",
      },
    ],
  },
  {
    sessionId: "daemon-leases",
    cwd: PIM,
    at: "2026-08-08T09:00:00.000Z",
    turns: [
      {
        role: "user",
        text: "Does the daemon hand out leases to every surface at once?",
      },
      {
        role: "assistant",
        text: "Only one surface holds a turn at a time; the daemon queues the rest.",
      },
    ],
  },
  {
    sessionId: "ws-gateway",
    cwd: PIM,
    at: "2026-08-07T09:00:00.000Z",
    turns: [
      {
        role: "user",
        text: "WsGateway drops the resume handshake when the socket reconnects twice.",
      },
      {
        role: "assistant",
        text: "The gateway replays from the last ordinal it fanned out.",
      },
    ],
  },
  {
    sessionId: "telegram-root",
    cwd: PIM,
    at: "2026-08-06T09:00:00.000Z",
    turns: [
      { role: "user", text: "Telegram sessions keep their own root." },
      {
        role: "assistant",
        text: "The telegram surface is its own product, not a window onto the browser.",
      },
    ],
  },
  {
    sessionId: "web-client",
    cwd: PIM,
    at: "2026-08-05T09:00:00.000Z",
    turns: [
      { role: "user", text: "The web client should not carry the index." },
      {
        role: "assistant",
        text: "A round trip over the web socket is a millisecond on the LAN.",
      },
      { role: "user", text: "The gateway should stay on the server." },
    ],
  },
  {
    sessionId: "telemetry",
    cwd: PIM,
    at: "2026-08-04T09:00:00.000Z",
    name: "Nightly telemetry sweep",
    turns: [
      { role: "user", text: "Sweep the telemetry at least once a night." },
      {
        role: "assistant",
        text: "Please leave the sweeper alone while it runs.",
      },
    ],
  },
  {
    sessionId: "quokka",
    cwd: MMORPG,
    at: "2026-08-03T09:00:00.000Z",
    turns: [
      {
        role: "user",
        text: "Name the test creature quokka so nothing else collides.",
      },
      { role: "assistant", text: "The sprite is in the atlas already." },
    ],
  },
  {
    sessionId: "editor-sidebar",
    cwd: MMORPG,
    at: "2026-08-02T09:00:00.000Z",
    turns: [
      { role: "user", text: "The editor sidebar needs the same search box." },
      {
        role: "assistant",
        text: "Reuse the sidebar rows rather than a second list.",
      },
    ],
  },
  {
    sessionId: "old-note",
    cwd: NOTES,
    at: "2026-07-02T09:00:00.000Z",
    turns: [
      {
        role: "user",
        text: "Old note: the lease outlives the daemon restart.",
      },
      { role: "assistant", text: "Worth checking before anything else moves." },
    ],
  },
  {
    sessionId: "quiet-note",
    cwd: NOTES,
    at: "2026-07-01T09:00:00.000Z",
    turns: [
      { role: "user", text: "Nothing interesting here yet." },
      { role: "assistant", text: "Understood." },
    ],
  },
  {
    sessionId: "long-opening",
    cwd: NOTES,
    at: "2026-06-30T09:00:00.000Z",
    turns: [
      {
        role: "user",
        text: "Throughput on the render path dropped after the last patch, and I cannot tell whether the encoder or the display is to blame, but throughput is the word I keep coming back to.",
      },
      { role: "assistant", text: "Noted, the numbers are in the run log." },
    ],
  },
];

function line(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

function directoryOf(cwd: string): string {
  return `-${cwd.replaceAll("/", "-")}-`;
}

function pathOf(root: string, session: CorpusSession): string {
  const stamp = session.at.replaceAll(":", "-").replace(".", "-");
  return join(
    root,
    directoryOf(session.cwd),
    `${stamp}_${session.sessionId}.jsonl`
  );
}

function turnLine(
  sessionId: string,
  at: number,
  ordinal: number,
  turn: CorpusTurn
): string {
  return line({
    type: "message",
    id: `${sessionId}-${ordinal}`,
    parentId: ordinal === 0 ? null : `${sessionId}-${ordinal - 1}`,
    timestamp: new Date(at + ordinal * 1000).toISOString(),
    message: { role: turn.role, content: [{ type: "text", text: turn.text }] },
  });
}

function textOf(session: CorpusSession): string {
  const header = line({
    type: "session",
    version: 3,
    id: session.sessionId,
    timestamp: session.at,
    cwd: session.cwd,
  });
  const named =
    session.name === undefined
      ? ""
      : line({
          type: "session_info",
          id: `${session.sessionId}-name`,
          parentId: null,
          timestamp: session.at,
          name: session.name,
        });
  const turns = session.turns.map((turn, ordinal) =>
    turnLine(session.sessionId, Date.parse(session.at), ordinal, turn)
  );
  return header + named + turns.join("");
}

/** Writes the tree under `root` and answers the summaries a registry would list. */
async function write(root: string): Promise<readonly SessionSummary[]> {
  const summaries: SessionSummary[] = [];
  for (const session of SESSIONS) {
    const path = pathOf(root, session);
    await mkdir(join(root, directoryOf(session.cwd)), { recursive: true });
    await Bun.write(path, textOf(session));
    summaries.push({
      sessionId: session.sessionId,
      cwd: session.cwd,
      path,
      createdAt: Date.parse(session.at),
      modifiedAt: Math.floor((await Bun.file(path).stat()).mtimeMs),
    });
  }
  return summaries;
}

/** Restats on every call, so an appended turn is visible to the next refresh, and a deleted file leaves the listing. */
function lister(
  summaries: readonly SessionSummary[]
): () => Promise<readonly SessionSummary[]> {
  return async () => {
    const listed = await Promise.all(
      summaries.map(async (summary) => {
        const stat = await Bun.file(summary.path)
          .stat()
          .catch(() => undefined);
        return stat === undefined
          ? undefined
          : { ...summary, modifiedAt: Math.floor(stat.mtimeMs) };
      })
    );
    return listed.filter((summary) => summary !== undefined);
  };
}

/** One more turn, as pi would have written it. */
function lineOf(summary: SessionSummary, turn: CorpusTurn, ordinal = 900): string {
  return turnLine(summary.sessionId, summary.createdAt, ordinal, turn);
}

/** Rewrites a session file and moves its mtime on, whatever the clock's resolution. */
async function edit(
  summary: SessionSummary,
  change: (text: string) => string
): Promise<void> {
  const file = Bun.file(summary.path);
  await file.write(change(await file.text()));
  const moved = new Date(Date.now() + 1000);
  await utimes(summary.path, moved, moved);
}

export const SearchCorpus = { write, lister, lineOf, edit };
