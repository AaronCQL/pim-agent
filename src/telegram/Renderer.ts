import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { GrammyError, type Api } from "grammy";
import { basename } from "node:path";

import type { SubagentDetails } from "../extensions/subagent/subagent";
import type { TodoInput } from "../extensions/todo/schema";
import type { LogsMode } from "./Config";
import { Markdown } from "./Markdown";
import type { Session, SessionId } from "./Session";

export type TurnEndState = "ok" | "cancelled" | "error";
type TurnState = TurnEndState | "running";

type TrackerEntry = {
  readonly key: string;
  readonly kind: "tool" | "todo" | "thinking" | "narration";
  readonly emoji: string;
  label: string;
  state: "running" | "ok" | "error";
};

const TOOL_EMOJI: Record<string, string> = {
  read: "📄",
  edit: "✏️",
  write: "✏️",
  bash: "⚡️",
  grep: "🔎",
  glob: "🔎",
  todo: "📋",
  web_search: "🌐",
  web_fetch: "🌐",
  send_file: "📤",
  task: "⏰",
  subagent: "🤖",
};

const MESSAGE_LIMIT = 4000;

export class Renderer {
  private readonly api: Api;
  private readonly sessionId: SessionId;
  private readonly logsMode: LogsMode;
  private readonly entries: TrackerEntry[] = [];
  private readonly toolIndex = new Map<string, number>();
  private readonly subagentBaseById = new Map<string, string>();
  private statusMessageId: number | undefined;
  private typingTimer: Timer | undefined;
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
    this.logsMode = session.settings.logsMode ?? "text";
  }

  public async start(): Promise<void> {
    await this.sendTyping();
    this.typingTimer = setInterval(() => void this.sendTyping(), 4_000);
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
      this.updateSubagentLabel(
        event.toolCallId,
        event.toolName,
        event.partialResult
      );
      return;
    }
    if (event.type === "tool_execution_end") {
      if (this.logsMode === "off") {
        return;
      }
      this.updateSubagentLabel(event.toolCallId, event.toolName, event.result);
      const idx = this.toolIndex.get(event.toolCallId);
      if (idx !== undefined) {
        this.entries[idx]!.state = event.isError ? "error" : "ok";
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
    const name = toolName.toLowerCase();
    if (name === "todo") {
      const content = Renderer.latestInProgressTodoContent(args);
      if (!content) {
        return;
      }
      this.entries.push({
        key: toolCallId,
        kind: "todo",
        emoji: TOOL_EMOJI.todo as string,
        label: content,
        state: "ok",
      });
      this.scheduleEdit();
      return;
    }
    const emoji = TOOL_EMOJI[name] ?? "⚙️";
    const label = Renderer.toolLabel(toolName, args);
    if (name === "subagent") {
      this.subagentBaseById.set(toolCallId, label);
    }
    const last = this.entries.at(-1);
    if (last?.kind === "tool" && last.emoji === emoji && last.label === label) {
      this.toolIndex.set(toolCallId, this.entries.length - 1);
      last.state = "running";
      this.scheduleEdit();
      return;
    }
    this.entries.push({
      key: toolCallId,
      kind: "tool",
      emoji,
      label,
      state: "running",
    });
    this.toolIndex.set(toolCallId, this.entries.length - 1);
    this.scheduleEdit();
  }

  private updateSubagentLabel(
    toolCallId: string,
    toolName: string,
    payload: unknown
  ): void {
    if (toolName.toLowerCase() !== "subagent") {
      return;
    }
    const idx = this.toolIndex.get(toolCallId);
    if (idx === undefined) {
      return;
    }
    const base = this.subagentBaseById.get(toolCallId);
    if (base === undefined) {
      return;
    }
    const details = (payload as { readonly details?: SubagentDetails } | null)
      ?.details;
    if (!details) {
      return;
    }
    const count = details.toolCalls.length + details.activeToolNames.length;
    const suffix =
      count > 0 ? ` (${count} ${count === 1 ? "tool" : "tools"})` : "";
    const next = `${base}${suffix}`;
    if (this.entries[idx]!.label === next) {
      return;
    }
    this.entries[idx]!.label = next;
    this.scheduleEdit();
  }

  private flushThinking(): void {
    if (this.logsMode !== "verbose") {
      this.thinking = "";
      return;
    }
    const text = Renderer.cleanProse(this.thinking);
    this.thinking = "";
    if (!text) {
      return;
    }
    const last = this.entries.at(-1);
    if (last?.kind === "thinking" && last.label === text) {
      return;
    }
    this.entries.push({
      key: `thinking-${this.entries.length}`,
      kind: "thinking",
      emoji: "",
      label: text,
      state: "ok",
    });
    this.scheduleEdit();
  }

  private pushNarration(): void {
    const raw = this.narration.trim();
    this.narration = "";
    if (!raw) {
      return;
    }
    if (this.logsMode !== "text" && this.logsMode !== "verbose") {
      return;
    }
    const text = Renderer.cleanProse(raw);
    const last = this.entries.at(-1);
    if (last?.kind === "narration" && last.label === text) {
      return;
    }
    this.entries.push({
      key: `narration-${this.entries.length}`,
      kind: "narration",
      emoji: "",
      label: text,
      state: "ok",
    });
    this.pendingNarrationCount += 1;
    this.scheduleEdit();
  }

  private settleMessageNarrations(message: unknown): void {
    const msg = message as {
      readonly role?: string;
      readonly stopReason?: string;
    };
    const isFinal = msg.role === "assistant" && msg.stopReason !== "toolUse";
    if (isFinal) {
      this.streamedFinalText = this.currentMessageText;
      if (this.pendingNarrationCount > 0) {
        let removed = 0;
        for (let i = 0; i < this.pendingNarrationCount; i++) {
          if (this.entries.at(-1)?.kind !== "narration") {
            break;
          }
          this.entries.pop();
          removed += 1;
        }
        if (removed > 0) {
          this.scheduleEdit();
        }
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
    const visible = this.entries.filter((entry) => this.entryVisible(entry));
    const pieces: string[] = [];
    if (visible.length === 0) {
      return "";
    }
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!;
      if (entry.kind === "todo") {
        pieces.push(`${entry.emoji} <b>${Markdown.escape(entry.label)}</b>`);
      } else if (entry.kind === "thinking") {
        pieces.push(`<i>${Markdown.toHtml(entry.label)}</i>`);
      } else if (entry.kind === "narration") {
        pieces.push(Markdown.toHtml(entry.label));
      } else {
        const isLastEntry = i === visible.length - 1;
        let suffix = "";
        if (entry.state === "error") {
          suffix = " ❌";
        } else if (state === "running" && isLastEntry) {
          suffix = " 🟡";
        }
        pieces.push(`${entry.emoji} ${entry.label}${suffix}`);
      }
      const next = visible[i + 1];
      if (next) {
        pieces.push(
          entry.kind === "tool" && next.kind === "tool" ? "\n" : "\n\n"
        );
      }
    }

    let body = pieces.join("");
    if (state === "cancelled") {
      body += "\n\n❌ Cancelled";
    } else if (state === "error") {
      body += "\n\n❌ Error";
    }
    return Renderer.capStatus(body);
  }

  private async sendFinal(markdown: string): Promise<void> {
    const html = Markdown.toHtml(markdown);
    for (const piece of Renderer.chunk(html)) {
      await this.sendMessage(piece, { status: false });
    }
  }

  private async sendTyping(): Promise<void> {
    await this.api
      .sendChatAction(this.sessionId.chatId, "typing", {
        message_thread_id: this.sessionId.threadId,
      })
      .catch(() => {});
  }

  private async sendMessage(
    html: string,
    opts: { readonly status: boolean }
  ): Promise<{ readonly message_id: number } | undefined> {
    if (!html) {
      return undefined;
    }
    const other = {
      parse_mode: "HTML" as const,
      message_thread_id: this.sessionId.threadId,
      link_preview_options: { is_disabled: true },
    };
    try {
      const msg = await this.api.sendMessage(
        this.sessionId.chatId,
        Renderer.sanitize(html),
        other
      );
      console.log(
        `[send] chatId=${this.sessionId.chatId} threadId=${this.sessionId.threadId ?? "main"} ${opts.status ? "status" : "answer"} ok (${html.length}b)`
      );
      return msg;
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400) {
        console.warn(`[send] HTML 400 (${err.description}) — retry plain`);
        const msg = await this.api.sendMessage(
          this.sessionId.chatId,
          Renderer.stripHtml(Renderer.sanitize(html)),
          {
            message_thread_id: this.sessionId.threadId,
            link_preview_options: { is_disabled: true },
          }
        );
        return msg;
      }
      throw err;
    }
  }

  private async editMessage(html: string): Promise<void> {
    try {
      await this.api.editMessageText(
        this.sessionId.chatId,
        this.statusMessageId!,
        Renderer.sanitize(html),
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
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
              Renderer.stripHtml(Renderer.sanitize(html)),
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

  private entryVisible(entry: TrackerEntry): boolean {
    if (this.logsMode === "off") {
      return false;
    }
    if (entry.kind === "tool" || entry.kind === "todo") {
      return true;
    }
    if (entry.kind === "narration") {
      return this.logsMode === "text" || this.logsMode === "verbose";
    }
    return this.logsMode === "verbose";
  }

  private clearTimers(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = undefined;
    }
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }

  private static toolLabel(toolName: string, args: unknown): string {
    const obj =
      args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const name = toolName.toLowerCase();
    const code = (s: string): string =>
      `<code>${Markdown.escape(Renderer.truncate(s, 160))}</code>`;

    if (
      name === "read" ||
      name === "edit" ||
      name === "write" ||
      name === "send_file"
    ) {
      const p = Renderer.stringArg(obj, "path");
      return p ? code(basename(p)) : "";
    }
    if (name === "bash") {
      const cmd = Renderer.stringArg(obj, "command");
      return cmd ? code(Renderer.firstLine(cmd)) : "";
    }
    if (name === "grep" || name === "glob") {
      const pattern =
        Renderer.stringArg(obj, "pattern") ?? Renderer.stringArg(obj, "query");
      const where =
        Renderer.stringArg(obj, "path") ?? Renderer.stringArg(obj, "glob");
      if (pattern && where) {
        return `${code(pattern)} in ${code(where)}`;
      }
      if (pattern) {
        return code(pattern);
      }
      return "";
    }
    if (name === "web_search" || name === "web_fetch") {
      const target =
        Renderer.stringArg(obj, "url") ?? Renderer.stringArg(obj, "query");
      return target ? Markdown.escape(Renderer.truncate(target, 180)) : "";
    }
    if (name === "task") {
      return Renderer.taskLabel(obj, code);
    }
    if (name === "subagent") {
      const prompt = Renderer.stringArg(obj, "prompt");
      return prompt
        ? Markdown.toHtml(Renderer.truncate(Renderer.firstLine(prompt), 180))
        : "";
    }

    const candidate =
      Renderer.stringArg(obj, "path") ??
      Renderer.stringArg(obj, "command") ??
      Renderer.stringArg(obj, "query") ??
      Renderer.stringArg(obj, "pattern") ??
      Renderer.stringArg(obj, "url");
    return Markdown.escape(
      Renderer.truncate(`${toolName}${candidate ? ` ${candidate}` : ""}`)
    );
  }

  private static firstLine(text: string): string {
    const idx = text.indexOf("\n");
    if (idx < 0) {
      return text;
    }
    return `${text.slice(0, idx).trimEnd()} …`;
  }

  private static stringArg(
    obj: Record<string, unknown>,
    key: string
  ): string | undefined {
    const value = obj[key];
    return typeof value === "string" && value ? value : undefined;
  }

  private static taskScheduleSummary(
    obj: Record<string, unknown>
  ): string | undefined {
    const sched = obj.schedule;
    if (!sched || typeof sched !== "object") {
      return undefined;
    }
    const s = sched as Record<string, unknown>;
    if (s.type === "once" && typeof s.at === "string") {
      return `once @ ${s.at}`;
    }
    if (s.type === "interval" && typeof s.every === "string") {
      return `every ${s.every}`;
    }
    if (s.type === "cron" && typeof s.expr === "string") {
      return `cron ${s.expr}`;
    }
    return undefined;
  }

  private static taskLabel(
    obj: Record<string, unknown>,
    code: (s: string) => string
  ): string {
    const action = Renderer.stringArg(obj, "action");
    if (!action) {
      return "";
    }
    if (action === "list") {
      return "List tasks";
    }
    if (action === "create") {
      const prompt = Renderer.stringArg(obj, "prompt");
      const sched = Renderer.taskScheduleSummary(obj);
      if (prompt && sched) {
        return `Schedule task: ${code(prompt)} (${Markdown.escape(sched)})`;
      }
      if (prompt) {
        return `Schedule task: ${code(prompt)}`;
      }
      return sched
        ? `Schedule task (${Markdown.escape(sched)})`
        : "Schedule task";
    }
    if (action === "update_prompt") {
      const prompt = Renderer.stringArg(obj, "prompt");
      return prompt ? `Update task: ${code(prompt)}` : "Update task";
    }
    const verb =
      action === "delete"
        ? "Delete"
        : action === "pause"
          ? "Pause"
          : action === "resume"
            ? "Resume"
            : action;
    const id = Renderer.stringArg(obj, "id");
    return id ? `${verb} task: ${code(id)}` : `${verb} task`;
  }

  private static latestInProgressTodoContent(
    args: unknown
  ): string | undefined {
    const todos =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Partial<TodoInput>).todos
        : undefined;
    if (!Array.isArray(todos)) {
      return undefined;
    }

    for (let i = todos.length - 1; i >= 0; i--) {
      const item = todos[i] as unknown;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const { content, status } = item as Record<string, unknown>;
      if (status !== "in_progress" || typeof content !== "string") {
        continue;
      }
      const normalized = content.trim().replaceAll(/\s+/g, " ");
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  private static cleanProse(text: string): string {
    return Renderer.truncate(text.replace(/\n{3,}/g, "\n\n").trim(), 900);
  }

  private static truncate(text: string, limit = 180): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
  }

  private static capStatus(text: string): string {
    if (text.length <= MESSAGE_LIMIT) {
      return text;
    }
    const lines = text.split("\n");
    let dropped = 0;
    let total = text.length;
    while (total > MESSAGE_LIMIT && lines.length > 1) {
      const first = lines.shift()!;
      total -= first.length + 1;
      dropped += 1;
    }
    return `… ${dropped} earlier entries\n${lines.join("\n")}`;
  }

  private static chunk(html: string): readonly string[] {
    if (html.length <= MESSAGE_LIMIT) {
      return [html];
    }
    const chunks: string[] = [];
    let rest = html;
    while (rest.length > MESSAGE_LIMIT) {
      const idx = rest.lastIndexOf("\n", MESSAGE_LIMIT);
      const splitAt = idx > 0 ? idx : MESSAGE_LIMIT;
      chunks.push(rest.slice(0, splitAt).trim());
      rest = rest.slice(splitAt).trim();
    }
    if (rest) {
      chunks.push(rest);
    }
    return chunks;
  }

  private static sanitize(text: string): string {
    return text.replace(
      /\b(api[_-]?key|token|secret)\b\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    );
  }

  private static stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  }
}
