import type {
  AgentSessionEvent,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { GrammyError, type Api } from "grammy";

import { Tools } from "../../core/src/shared/Tools";
import { MarkdownPainter } from "../../core/src/view/MarkdownPainter";
import type { LogsMode } from "./Config";
import { Markdown } from "./Markdown";
import type { Session, SessionId } from "./Session";
import { TypingIndicator } from "./TypingIndicator";

export type TurnEndState = "ok" | "cancelled" | "error";
type TurnState = TurnEndState | "running";

type TrackerEntry = {
  readonly key: string;
  readonly kind: "tool" | "thinking" | "narration";
  icon: string;
  label: string;
  state: "running" | "ok" | "error";
};

/** What a later update needs to repaint a row: its tool, and what it was called with. */
type ToolCall = {
  readonly index: number;
  readonly toolName: string;
  readonly args: unknown;
};

const MESSAGE_LIMIT = 32000;
const BR = "<br>";
const BLOCK_TAGS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ol",
  "p",
  "pre",
  "table",
  "tg-math-block",
  "ul",
]);
const VOID_BLOCK_TAGS = new Set(["br", "hr"]);

type HtmlTag = {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
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
      // A failed call's result is pi's synthetic error one, whose details are
      // empty; repainting from it would drop what the call already showed.
      if (!event.isError) {
        this.refreshTool(event.toolCallId, event.result, false);
      }
      const call = this.calls.get(event.toolCallId);
      if (call !== undefined) {
        this.entries[call.index]!.state = event.isError ? "error" : "ok";
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

    // A repeat of the row already at the bottom reopens it instead of stacking
    // an identical line, e.g. a retried read of the same file.
    if (last?.kind === "tool" && last.icon === icon && last.label === label) {
      last.state = "running";
    } else {
      this.entries.push({
        key: toolCallId,
        kind: "tool",
        icon,
        label,
        state: "running",
      });
    }

    this.calls.set(toolCallId, {
      index: this.entries.length - 1,
      toolName,
      args,
    });
    this.scheduleEdit();
  }

  /**
   * Repaints a row from the same view model, now that the tool has a result to
   * fold in: line counts, a provider name, a subagent's progress.
   */
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
    const entry = this.entries[call.index]!;
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
    if (this.logsMode !== "verbose") {
      this.thinking = "";
      return;
    }
    const text = cleanProse(this.thinking);
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
      icon: "",
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
    const text = cleanProse(raw);
    const last = this.entries.at(-1);
    if (last?.kind === "narration" && last.label === text) {
      return;
    }
    this.entries.push({
      key: `narration-${this.entries.length}`,
      kind: "narration",
      icon: "",
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
      if (entry.kind === "thinking") {
        pieces.push(Markdown.toHtml(entry.label, { italics: true }));
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
        pieces.push(`${entry.icon} ${entry.label}${suffix}`);
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
    return capStatus(body);
  }

  private async sendFinal(markdown: string): Promise<void> {
    const html = Markdown.toHtml(markdown);
    for (const piece of chunk(html)) {
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
    const clean = sanitize(html);
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
        return this.api.sendMessage(this.sessionId.chatId, stripHtml(clean), {
          message_thread_id: this.sessionId.threadId,
          link_preview_options: { is_disabled: true },
        });
      }
      throw err;
    }
  }

  private async editMessage(html: string): Promise<void> {
    const clean = sanitize(html);
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
              stripHtml(clean),
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
    if (entry.kind === "tool") {
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
}

function isInlineEntry(entry: TrackerEntry): boolean {
  return entry.kind === "tool";
}

function cleanProse(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function capStatus(text: string): string {
  if (text.length <= MESSAGE_LIMIT) {
    return text;
  }
  const blocks = splitStatusBlocks(text);
  let dropped = 0;
  while (blocks.length > 1) {
    blocks.shift();
    dropped += 1;
    const rest = trimLeadingBreaks(blocks.join("").trimStart());
    const candidate = `<p>… ${dropped} earlier entries</p>${rest}`;
    if (candidate.length <= MESSAGE_LIMIT) {
      return candidate;
    }
  }
  return capPlainStatus(blocks);
}

function splitStatusBlocks(html: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const tag = nextStatusBlockTag(html, cursor);
    if (!tag) {
      pushStatusBlock(blocks, html.slice(cursor));
      break;
    }
    if (VOID_BLOCK_TAGS.has(tag.name)) {
      pushStatusBlock(blocks, html.slice(cursor, tag.end));
      cursor = tag.end;
      continue;
    }
    pushStatusBlock(blocks, html.slice(cursor, tag.start));
    const end = statusBlockEnd(html, tag);
    pushStatusBlock(blocks, html.slice(tag.start, end));
    cursor = end;
  }
  return blocks;
}

function nextStatusBlockTag(html: string, start: number): HtmlTag | undefined {
  const tags = htmlTags(html, start);
  for (const tag of tags) {
    if (tag.closing) {
      continue;
    }
    if (BLOCK_TAGS.has(tag.name) || VOID_BLOCK_TAGS.has(tag.name)) {
      return tag;
    }
  }
  return undefined;
}

function statusBlockEnd(html: string, opener: HtmlTag): number {
  if (opener.selfClosing) {
    return opener.end;
  }
  const stack = [opener.name];
  const tags = htmlTags(html, opener.end);
  for (const tag of tags) {
    if (VOID_BLOCK_TAGS.has(tag.name)) {
      continue;
    }
    if (!BLOCK_TAGS.has(tag.name)) {
      continue;
    }
    if (tag.closing) {
      if (stack.at(-1) === tag.name) {
        stack.pop();
      }
    } else if (!tag.selfClosing) {
      stack.push(tag.name);
    }
    if (stack.length === 0) {
      return tag.end;
    }
  }
  return html.length;
}

function* htmlTags(html: string, start: number): Generator<HtmlTag> {
  const re = /<\s*(\/)?\s*([a-z][\w:-]*)(?:\s[^>]*)?\/?\s*>/gi;
  re.lastIndex = start;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    const raw = match[0]!;
    yield {
      start: match.index,
      end: re.lastIndex,
      name: match[2]!.toLowerCase(),
      closing: match[1] !== undefined,
      selfClosing: /\/\s*>$/.test(raw),
    };
  }
}

function pushStatusBlock(blocks: string[], block: string): void {
  if (block) {
    blocks.push(block);
  }
}

function trimLeadingBreaks(text: string): string {
  return text.replace(/^(?:<br\s*\/?>)+/i, "").trimStart();
}

function capPlainStatus(blocks: readonly string[]): string {
  let head = "";
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const candidate = `${head}${block}`;
    if (candidate.length <= MESSAGE_LIMIT) {
      head = candidate;
      continue;
    }
    const remaining = MESSAGE_LIMIT - head.length;
    const truncated = truncateHtmlHead(block, remaining);
    if (truncated) {
      head = `${head}${truncated}`;
    }
    break;
  }
  return head.trimEnd();
}

function truncateHtmlHead(html: string, limit: number): string {
  if (html.length <= limit) {
    return html;
  }
  if (limit <= 0) {
    return "";
  }
  const wrapper = outerHtmlWrapper(html);
  if (wrapper) {
    const innerLimit = limit - wrapper.open.length - wrapper.close.length;
    if (innerLimit > 0) {
      const inner = truncateHtmlHead(wrapper.inner, innerLimit);
      if (inner) {
        return `${wrapper.open}${inner}${wrapper.close}`;
      }
    }
  }
  return escapePlainHead(stripHtml(html), limit);
}

function outerHtmlWrapper(html: string):
  | {
      readonly open: string;
      readonly inner: string;
      readonly close: string;
    }
  | undefined {
  const opener = /^<\s*([a-z][\w:-]*)(?:\s[^>]*)?\/?\s*>/i.exec(html);
  if (!opener) {
    return undefined;
  }
  const open = opener[0]!;
  if (/\/\s*>$/.test(open)) {
    return undefined;
  }
  const name = opener[1]!.toLowerCase();
  const close = matchingHtmlCloseTag(html, name, open.length);
  if (!close || close.end !== html.length) {
    return undefined;
  }
  return {
    open,
    inner: html.slice(open.length, close.start),
    close: html.slice(close.start, close.end),
  };
}

function matchingHtmlCloseTag(
  html: string,
  name: string,
  start: number
): HtmlTag | undefined {
  let depth = 1;
  const tags = htmlTags(html, start);
  for (const tag of tags) {
    if (tag.name !== name) {
      continue;
    }
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) {
        return tag;
      }
    } else if (!tag.selfClosing && !VOID_BLOCK_TAGS.has(tag.name)) {
      depth += 1;
    }
  }
  return undefined;
}

function escapePlainHead(text: string, limit: number): string {
  const marker = "…";
  if (limit < marker.length) {
    return "";
  }
  const budget = limit - marker.length;
  const escaped: string[] = [];
  let length = 0;
  for (const char of text) {
    const next = char === "\n" ? BR : Markdown.escape(char);
    if (length + next.length > budget) {
      break;
    }
    escaped.push(next);
    length += next.length;
  }
  return `${escaped.join("").trimEnd()}${marker}`;
}

function chunk(html: string): readonly string[] {
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

function sanitize(text: string): string {
  return text.replace(
    /\b(api[_-]?key|token|secret)\b\s*[:=]\s*\S+/gi,
    "$1=[redacted]"
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
