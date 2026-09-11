import type {
  AgentSessionEvent,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { GrammyError, type Api } from "grammy";

import { Tools } from "#core/shared/Tools";
import { MarkdownPainter } from "#core/view/MarkdownPainter";
import type { LogsMode } from "./Config";
import { Markdown } from "./Markdown";
import type { Session, SessionId } from "./Session";
import { BR, TelegramHtml } from "./TelegramHtml";
import { TypingIndicator } from "./TypingIndicator";

export type TurnEndState = "ok" | "cancelled" | "error";
type TurnState = TurnEndState | "running";

type ToolEntry = {
  readonly kind: "tool";
  icon: string;
  label: string;
  state: "running" | "ok" | "error";
};

type ProseKind = "thinking" | "narration";

type ProseEntry = {
  readonly kind: ProseKind;
  readonly label: string;
  html?: string;
};

type TrackerEntry = ToolEntry | ProseEntry;

const PROSE_OPTS = {
  thinking: { italics: true },
  narration: {},
} as const;

type ToolCall = {
  readonly index: number;
  readonly toolName: string;
  readonly args: unknown;
};

export class Renderer {
  private readonly api: Api;
  private readonly sessionId: SessionId;
  private readonly logsMode: LogsMode;
  private readonly entries: TrackerEntry[] = [];
  private readonly calls = new Map<string, ToolCall>();
  private readonly cwd: string;
  private readonly typing: TypingIndicator;
  private statusMessageId: number | undefined;
  private editTimer: Timer | undefined;
  private thinking = "";
  private narration = "";
  private currentMessageText = "";
  private streamedFinalText = "";
  private pendingNarrationCount = 0;
  private lastRendered = "";
  private stopped = false;

  public constructor(session: Session, api: Api) {
    this.api = api;
    this.sessionId = session.id;
    this.cwd = session.cwd;
    this.logsMode = session.settings.logsMode ?? "text";
    this.typing = new TypingIndicator(api, session.id);
  }

  public start(): void {
    this.typing.start();
  }

  public handleEvent(event: AgentSessionEvent): void {
    if (this.stopped) {
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as {
        readonly type: string;
        readonly delta?: string;
        readonly content?: string;
      };
      if (update.type === "thinking_delta") {
        this.thinking += update.delta ?? "";
        return;
      }
      if (update.type === "thinking_end") {
        this.thinking = update.content ?? this.thinking;
        this.flushThinking();
        return;
      }
      if (update.type === "text_delta") {
        this.flushThinking();
        this.narration += update.delta ?? "";
        this.currentMessageText += update.delta ?? "";
        return;
      }
      if (update.type === "text_end") {
        this.narration = update.content ?? this.narration;
        this.pushNarration();
        return;
      }
      this.flushThinking();
      return;
    }
    if (event.type === "message_start") {
      this.flushThinking();
      this.narration = "";
      this.currentMessageText = "";
      this.pendingNarrationCount = 0;
      return;
    }
    if (event.type === "tool_execution_start") {
      this.flushThinking();
      if (this.logsMode === "off") {
        return;
      }
      this.addTool(event.toolCallId, event.toolName, event.args);
      return;
    }
    if (event.type === "tool_execution_update") {
      if (this.logsMode === "off") {
        return;
      }
      this.refreshTool(event.toolCallId, event.partialResult, true);
      return;
    }
    if (event.type === "tool_execution_end") {
      if (this.logsMode === "off") {
        return;
      }
      // A failed call's result is pi's synthetic empty error; repainting drops the row's details.
      if (!event.isError) {
        this.refreshTool(event.toolCallId, event.result, false);
      }
      const call = this.calls.get(event.toolCallId);
      const entry = call === undefined ? undefined : this.entries[call.index];
      if (entry?.kind === "tool") {
        entry.state = event.isError ? "error" : "ok";
        this.scheduleEdit();
      }
      return;
    }
    if (event.type === "message_end") {
      this.flushThinking();
      this.settleMessageNarrations(event.message);
      return;
    }
    if (event.type === "agent_end") {
      this.flushThinking();
      this.narration = "";
    }
  }

  public async finish(finalText: string, state: TurnEndState): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.flushThinking();
    this.narration = "";
    await this.flushEdit(state);
    const textToSend = finalText.trim()
      ? finalText
      : this.streamedFinalText.trim();
    if (textToSend) {
      await this.sendFinal(textToSend);
    }
  }

  private addTool(toolCallId: string, toolName: string, args: unknown): void {
    const { icon, label } = this.paintTool(toolName, args, undefined, true);
    const last = this.entries.at(-1);

    if (last?.kind === "tool" && last.icon === icon && last.label === label) {
      last.state = "running";
    } else {
      this.entries.push({ kind: "tool", icon, label, state: "running" });
    }

    this.calls.set(toolCallId, {
      index: this.entries.length - 1,
      toolName,
      args,
    });
    this.scheduleEdit();
  }

  private refreshTool(
    toolCallId: string,
    result: unknown,
    isPartial: boolean
  ): void {
    const call = this.calls.get(toolCallId);
    if (call === undefined) {
      return;
    }
    const { icon, label } = this.paintTool(
      call.toolName,
      call.args,
      result as AgentToolResult<unknown> | undefined,
      isPartial
    );
    const entry = this.entries[call.index];
    if (entry?.kind !== "tool") {
      return;
    }
    if (entry.icon === icon && entry.label === label) {
      return;
    }
    entry.icon = icon;
    entry.label = label;
    this.scheduleEdit();
  }

  private paintTool(
    toolName: string,
    args: unknown,
    result: AgentToolResult<unknown> | undefined,
    isPartial: boolean
  ): { readonly icon: string; readonly label: string } {
    const painted = MarkdownPainter.paintTool(
      Tools.viewOf({
        name: toolName,
        args,
        ...(result === undefined ? {} : { result }),
        isPartial,
        cwd: this.cwd,
      })
    );
    return { icon: painted.icon, label: painted.lines.join(BR) };
  }

  private flushThinking(): void {
    const raw = this.thinking;
    this.thinking = "";
    if (this.logsMode !== "verbose") {
      return;
    }
    this.pushProse("thinking", raw);
  }

  private pushNarration(): void {
    const raw = this.narration;
    this.narration = "";
    if (this.logsMode !== "text" && this.logsMode !== "verbose") {
      return;
    }
    if (this.pushProse("narration", raw)) {
      this.pendingNarrationCount += 1;
    }
  }

  private pushProse(kind: ProseKind, raw: string): boolean {
    const text = cleanProse(raw);
    if (!text) {
      return false;
    }
    const last = this.entries.at(-1);
    if (last?.kind === kind && last.label === text) {
      return false;
    }
    this.entries.push({ kind, label: text });
    this.scheduleEdit();
    return true;
  }

  private settleMessageNarrations(message: unknown): void {
    const msg = message as {
      readonly role?: string;
      readonly stopReason?: string;
    };
    const isFinal = msg.role === "assistant" && msg.stopReason !== "toolUse";
    if (isFinal) {
      this.streamedFinalText = this.currentMessageText;
      const before = this.entries.length;
      for (let i = 0; i < this.pendingNarrationCount; i++) {
        if (this.entries.at(-1)?.kind !== "narration") {
          break;
        }
        this.entries.pop();
      }
      if (this.entries.length !== before) {
        this.scheduleEdit();
      }
    }
    this.pendingNarrationCount = 0;
  }

  private scheduleEdit(): void {
    if (this.logsMode === "off") {
      return;
    }
    if (this.editTimer) {
      return;
    }
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      if (this.stopped) {
        return;
      }
      void this.flushEdit("running");
    }, 1_000);
  }

  private async flushEdit(state: TurnState): Promise<void> {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
    if (this.logsMode === "off") {
      return;
    }
    const body = this.renderStatus(state);
    if (!body) {
      return;
    }
    if (body === this.lastRendered) {
      return;
    }
    this.lastRendered = body;
    if (this.statusMessageId === undefined) {
      const msg = await this.sendMessage(body, { status: true });
      this.statusMessageId = msg?.message_id;
      return;
    }
    await this.editMessage(body);
  }

  private renderStatus(state: TurnState): string {
    const visible = this.entries;
    const pieces: string[] = [];
    if (visible.length === 0) {
      return "";
    }
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!;
      if (entry.kind === "tool") {
        const isLastEntry = i === visible.length - 1;
        let suffix = "";
        if (entry.state === "error") {
          suffix = " ❌";
        } else if (state === "running" && isLastEntry) {
          suffix = " 🟡";
        }
        pieces.push(`${entry.icon} ${entry.label}${suffix}`);
      } else {
        entry.html ??= Markdown.toHtml(entry.label, PROSE_OPTS[entry.kind]);
        pieces.push(entry.html);
      }
      const next = visible[i + 1];
      if (next && isInlineEntry(entry) && isInlineEntry(next)) {
        pieces.push(BR);
      }
    }

    let body = pieces.join("");
    if (state === "cancelled") {
      body += "<br><br>❌ Cancelled";
    } else if (state === "error") {
      body += "<br><br>❌ Error";
    }
    return TelegramHtml.cap(body);
  }

  private async sendFinal(markdown: string): Promise<void> {
    const html = Markdown.toHtml(markdown);
    for (const piece of TelegramHtml.chunk(html)) {
      await this.sendMessage(piece, { status: false });
    }
  }

  private async sendMessage(
    html: string,
    opts: { readonly status: boolean }
  ): Promise<{ readonly message_id: number } | undefined> {
    if (!html) {
      return undefined;
    }
    const clean = TelegramHtml.sanitize(html);
    try {
      const msg = await this.api.sendRichMessage(
        this.sessionId.chatId,
        { html: clean },
        { message_thread_id: this.sessionId.threadId }
      );
      console.log(
        `[send] chatId=${this.sessionId.chatId} threadId=${this.sessionId.threadId ?? "main"} ${opts.status ? "status" : "answer"} ok (${clean.length}b)`
      );
      return msg;
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400) {
        console.warn(`[send] rich 400 (${err.description}) — retry plain`);
        return this.api.sendMessage(
          this.sessionId.chatId,
          TelegramHtml.strip(clean),
          {
            message_thread_id: this.sessionId.threadId,
            link_preview_options: { is_disabled: true },
          }
        );
      }
      throw err;
    }
  }

  private async editMessage(html: string): Promise<void> {
    const clean = TelegramHtml.sanitize(html);
    try {
      await this.api.editMessageText(
        this.sessionId.chatId,
        this.statusMessageId!,
        {
          html: clean,
        }
      );
    } catch (err) {
      if (err instanceof GrammyError) {
        if (/message is not modified/i.test(err.description)) {
          return;
        }
        if (err.error_code === 400) {
          await this.api
            .editMessageText(
              this.sessionId.chatId,
              this.statusMessageId!,
              TelegramHtml.strip(clean),
              {
                link_preview_options: { is_disabled: true },
              }
            )
            .catch(() => {});
          return;
        }
      }
      console.warn(`[send] status edit failed:`, err);
    }
  }

  private clearTimers(): void {
    this.typing.stop();
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }
}

function isInlineEntry(entry: TrackerEntry): boolean {
  return entry.kind === "tool";
}

function cleanProse(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
