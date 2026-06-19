import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { GrammyError, type Api } from "grammy";
import { basename } from "node:path";

import type { ApplyEntry } from "../extensions/apply-patch/executor";
import type { SubagentDetails } from "../extensions/subagent/subagent";
import type { TodoInput } from "../extensions/todo/schema";
import type { ToolDiff } from "../shared/DiffLines";
import { DiffView, type DiffStats } from "../shared/DiffView";
import { type PatchOp, PatchSummary } from "../shared/PatchSummary";
import type { LogsMode } from "./Config";
import { Markdown } from "./Markdown";
import type { Session, SessionId } from "./Session";
import { TypingIndicator } from "./TypingIndicator";

export type TurnEndState = "ok" | "cancelled" | "error";
type TurnState = TurnEndState | "running";

type TrackerEntry = {
  readonly key: string;
  readonly kind: "tool" | "todo" | "thinking" | "narration";
  emoji: string;
  label: string;
  state: "running" | "ok" | "error";
  // Plaintext "+4/-3" appended after the label once the tool finishes.
  stats?: string;
};

type ApplyOp = {
  readonly emoji: string;
  readonly text: string;
};

const EDIT_EMOJI = "✏️";
const DELETE_EMOJI = "🗑️";
const ARROW = "➝";

// Keys an apply_patch tool call may carry its patch text under (canonical first).
const PATCH_TEXT_KEYS = ["input", "patch", "patchText", "patch_text"] as const;

const TOOL_EMOJI: Record<string, string> = {
  read: "📄",
  edit: EDIT_EMOJI,
  write: EDIT_EMOJI,
  apply_patch: EDIT_EMOJI,
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

const MESSAGE_LIMIT = 32000;
const BR = "<br>";

export class Renderer {
  private readonly api: Api;
  private readonly sessionId: SessionId;
  private readonly logsMode: LogsMode;
  private readonly entries: TrackerEntry[] = [];
  private readonly toolIndex = new Map<string, number>();
  private readonly subagentBaseById = new Map<string, string>();
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
      if (!event.isError) {
        this.applyDiffStats(event.toolCallId, event.toolName, event.result);
      }
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
    if (name === "apply_patch") {
      const { emoji, label } = Renderer.buildApplyEntry(
        Renderer.applyOpsFromArgs(args)
      );
      this.entries.push({
        key: toolCallId,
        kind: "tool",
        emoji,
        label,
        state: "running",
      });
      this.toolIndex.set(toolCallId, this.entries.length - 1);
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

  private applyDiffStats(
    toolCallId: string,
    toolName: string,
    result: unknown
  ): void {
    const idx = this.toolIndex.get(toolCallId);
    if (idx === undefined) {
      return;
    }
    const name = toolName.toLowerCase();
    const details = (result as { readonly details?: unknown } | null)?.details;
    if (name === "edit" || name === "write") {
      const diff = (details as { readonly diff?: ToolDiff } | undefined)?.diff;
      const stats = Renderer.formatPlainStats(DiffView.countStats(diff));
      if (stats) {
        this.entries[idx]!.stats = stats;
        this.scheduleEdit();
      }
      return;
    }
    if (name === "apply_patch") {
      const entries = (
        details as { readonly entries?: readonly ApplyEntry[] } | undefined
      )?.entries;
      if (!entries) {
        return;
      }
      const built = Renderer.buildApplyEntry(
        Renderer.applyOpsFromEntries(entries)
      );
      this.entries[idx]!.emoji = built.emoji;
      this.entries[idx]!.label = built.label;
      this.scheduleEdit();
    }
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
        pieces.push(`<i>${Renderer.escapeInline(entry.label)}</i>`);
      } else if (entry.kind === "narration") {
        pieces.push(Renderer.escapeInline(entry.label));
      } else {
        const isLastEntry = i === visible.length - 1;
        let suffix = "";
        if (entry.state === "error") {
          suffix = " ❌";
        } else if (state === "running" && isLastEntry) {
          suffix = " 🟡";
        }
        const stats = entry.stats ? ` ${entry.stats}` : "";
        pieces.push(`${entry.emoji} ${entry.label}${stats}${suffix}`);
      }
      const next = visible[i + 1];
      if (next) {
        pieces.push(
          entry.kind === "tool" && next.kind === "tool" ? "<br>" : "<br><br>"
        );
      }
    }

    let body = pieces.join("");
    if (state === "cancelled") {
      body += "<br><br>❌ Cancelled";
    } else if (state === "error") {
      body += "<br><br>❌ Error";
    }
    return Renderer.capStatus(body);
  }

  private async sendFinal(markdown: string): Promise<void> {
    const html = Markdown.toHtml(markdown);
    for (const piece of Renderer.chunk(html)) {
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
    const clean = Renderer.sanitize(html);
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
          Renderer.stripHtml(clean),
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
    const clean = Renderer.sanitize(html);
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
              Renderer.stripHtml(clean),
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
    this.typing.stop();
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }

  private static buildApplyEntry(ops: readonly ApplyOp[]): {
    readonly emoji: string;
    readonly label: string;
  } {
    const [first, ...rest] = ops;
    if (!first) {
      return { emoji: EDIT_EMOJI, label: "" };
    }
    const label = [
      first.text,
      ...rest.map((op) => `${op.emoji} ${op.text}`),
    ].join("<br>");
    return { emoji: first.emoji, label };
  }

  private static applyOpsFromArgs(args: unknown): readonly ApplyOp[] {
    const text = Renderer.patchTextFromArgs(args);
    if (!text) {
      return [];
    }
    return PatchSummary.fromText(text).map((op) => Renderer.opFromSummary(op));
  }

  private static applyOpsFromEntries(
    entries: readonly ApplyEntry[]
  ): readonly ApplyOp[] {
    return entries
      .filter(
        (entry) => !(entry.action.kind === "update" && entry.diff === undefined)
      )
      .map((entry) => Renderer.opFromEntry(entry));
  }

  private static opFromSummary(op: PatchOp): ApplyOp {
    const isMove = op.movePath !== undefined && op.movePath !== op.path;
    return Renderer.applyOp({
      kind: isMove ? "move" : op.kind,
      path: op.path,
      movePath: op.movePath,
    });
  }

  private static opFromEntry(entry: ApplyEntry): ApplyOp {
    return Renderer.applyOp({
      kind: entry.action.kind,
      path: entry.action.path,
      movePath: entry.action.movePath,
      stats: Renderer.formatPlainStats(DiffView.countStats(entry.diff)),
    });
  }

  private static applyOp(params: {
    readonly kind: "add" | "delete" | "move" | "update";
    readonly path: string;
    readonly movePath?: string;
    readonly stats?: string;
  }): ApplyOp {
    const suffix = params.stats ? ` ${params.stats}` : "";
    if (params.kind === "delete") {
      return {
        emoji: DELETE_EMOJI,
        text: `${Renderer.codeName(params.path)}${suffix}`,
      };
    }
    if (params.kind === "move") {
      return {
        emoji: EDIT_EMOJI,
        text: `${Renderer.moveText(params.path, params.movePath ?? params.path)}${suffix}`,
      };
    }
    return {
      emoji: EDIT_EMOJI,
      text: `${Renderer.codeName(params.path)}${suffix}`,
    };
  }

  private static moveText(from: string, to: string): string {
    return `${Renderer.codeName(from)} ${ARROW} ${Renderer.codeName(to)}`;
  }

  private static codeName(path: string): string {
    return `<code>${Markdown.escape(basename(path))}</code>`;
  }

  private static patchTextFromArgs(args: unknown): string | undefined {
    if (typeof args === "string") {
      return args;
    }
    if (!args || typeof args !== "object") {
      return undefined;
    }
    const record = args as Record<string, unknown>;
    for (const key of PATCH_TEXT_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value) {
        return value;
      }
    }
    return undefined;
  }

  private static formatPlainStats(stats: DiffStats): string {
    const parts: string[] = [];
    if (stats.added > 0) {
      parts.push(`+${stats.added}`);
    }
    if (stats.removed > 0) {
      parts.push(`-${stats.removed}`);
    }
    return parts.join("/");
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
        ? Renderer.escapeInline(
            Renderer.truncate(Renderer.firstLine(prompt), 180)
          )
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
    const lines = text.split(BR);
    let dropped = 0;
    let total = text.length;
    while (total > MESSAGE_LIMIT && lines.length > 1) {
      const first = lines.shift()!;
      total -= first.length + BR.length;
      dropped += 1;
    }
    return `… ${dropped} earlier entries${BR}${lines.join(BR)}`;
  }

  private static chunk(html: string): readonly string[] {
    if (html.length <= MESSAGE_LIMIT) {
      return [html];
    }
    const chunks: string[] = [];
    let rest = html;
    while (rest.length > MESSAGE_LIMIT) {
      const idx = rest.lastIndexOf(BR, MESSAGE_LIMIT);
      if (idx > 0) {
        chunks.push(rest.slice(0, idx).trim());
        rest = rest.slice(idx + BR.length).trim();
      } else {
        chunks.push(rest.slice(0, MESSAGE_LIMIT).trim());
        rest = rest.slice(MESSAGE_LIMIT).trim();
      }
    }
    if (rest) {
      chunks.push(rest);
    }
    return chunks;
  }

  private static escapeInline(text: string): string {
    return Markdown.escape(text).replace(/\n/g, BR);
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
