import { join } from "node:path";

import { SessionRegistry } from "./SessionRegistry.ts";

export type ThreadInstructionContext = {
  readonly configDir: string;
  readonly chatId: number;
  readonly threadId: number | undefined;
};

export function threadInstructionPath(ctx: ThreadInstructionContext): string {
  const key = SessionRegistry.key({
    chatId: ctx.chatId,
    threadId: ctx.threadId,
  });
  return join(ctx.configDir, "instructions", `${key}.md`);
}

export async function loadWrappedThreadInstruction(
  ctx: ThreadInstructionContext
): Promise<string | undefined> {
  const path = threadInstructionPath(ctx);
  let userContent: string | undefined;
  try {
    userContent = (await Bun.file(path).text()).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[thread-prompt] failed to read ${path}:`, err);
    }
  }
  const systemIx =
    "You are running as a Telegram bot powered by Pim Agent. The thread_user_instructions below are your editable per-thread system instructions; edit the file at its `path` attribute to update your instructions for this chat/thread.";
  const userIx = `<thread_user_instructions path="${path}">${userContent ? `\n${userContent}\n` : ""}</thread_user_instructions>`;
  return `<telegram_system_instructions>\n${systemIx}\n${userIx}\n</telegram_system_instructions>`;
}
