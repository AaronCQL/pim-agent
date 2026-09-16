import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";

/**
 * The pieces a session listing is read off, for the tests that need a session
 * on disk no prompt could have produced.
 */
export type SessionDraft = {
  readonly agentDir: string;
  readonly id: string;
  readonly cwd: string;
  readonly repliedAt: string;
  /** A message typed in after the answer, which no prompt can produce. */
  readonly saidAt?: string;
  /** The provider record pi totals the moment an agent adopts the file. */
  readonly usage?: boolean;
  /** Dates the file by its reply, so modified-time order is writing order. */
  readonly dated?: boolean;
};

const TOTALS = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function line(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

function messageLine(at: string, message: unknown): string {
  return line({
    type: "message",
    id: at,
    parentId: null,
    timestamp: at,
    message,
  });
}

function answerOf(draft: SessionDraft): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    ...(draft.usage === true
      ? {
          api: "openai-completions",
          provider: "test",
          model: "echo",
          usage: TOTALS,
          stopReason: "stop",
          timestamp: Date.parse(draft.repliedAt),
        }
      : {}),
  };
}

function pathOf(agentDir: string, id: string): string {
  return join(agentDir, "sessions", "written", `${id}.jsonl`);
}

/** A session pi could have written: one question, one answer, both at `repliedAt`. */
async function write(draft: SessionDraft): Promise<void> {
  const path = pathOf(draft.agentDir, draft.id);
  await mkdir(join(draft.agentDir, "sessions", "written"), { recursive: true });
  await Bun.write(
    path,
    line({
      type: "session",
      version: 3,
      id: draft.id,
      timestamp: draft.repliedAt,
      cwd: draft.cwd,
    }) +
      messageLine(draft.repliedAt, {
        role: "user",
        content: [{ type: "text", text: "say hello" }],
      }) +
      messageLine(draft.repliedAt, answerOf(draft)) +
      (draft.saidAt === undefined
        ? ""
        : messageLine(draft.saidAt, {
            role: "user",
            content: [{ type: "text", text: "and again" }],
          }))
  );
  if (draft.dated === true) {
    const seconds = Date.parse(draft.repliedAt) / 1000;
    await utimes(path, seconds, seconds);
  }
}

/** A whole-second ISO timestamp `n` minutes before now. */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

function rowIn<Row extends { readonly sessionId: string }>(
  rows: readonly Row[],
  sessionId: string
): Row | undefined {
  return rows.find((row) => row.sessionId === sessionId);
}

export const SessionFixture = { write, minutesAgo, rowIn };
