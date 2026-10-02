import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";

export type SessionDraft = {
  readonly agentDir: string;
  readonly id: string;
  readonly cwd: string;
  readonly repliedAt: string;
  /** Adds a user message after the answer. */
  readonly saidAt?: string;
  /** Adds provider usage to the answer. */
  readonly usage?: boolean;
  /** Sets the file mtime to `repliedAt`. */
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

/** One question and one answer, both at `repliedAt`. */
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

/** ISO timestamp `n` minutes before now. */
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
