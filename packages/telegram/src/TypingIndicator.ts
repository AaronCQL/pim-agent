import type { Api } from "grammy";

import type { SessionId } from "./Session";

export class TypingIndicator {
  private readonly api: Api;
  private readonly sessionId: SessionId;
  private timer: Timer | undefined;
  private stopped = true;

  public constructor(api: Api, sessionId: SessionId) {
    this.api = api;
    this.sessionId = sessionId;
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    void this.send();
    this.timer = setInterval(() => void this.send(), 4_000);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async send(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.api
      .sendChatAction(this.sessionId.chatId, "typing", {
        message_thread_id: this.sessionId.threadId,
      })
      .catch(() => {});
  }
}
