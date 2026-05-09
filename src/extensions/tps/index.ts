import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("tps", {
    description: "Toggle per-turn decode/prefill tps reporting",
    handler: async (_args, ctx) => {
      const current = await PimSettings.get("tps");
      const next = { ...current, enabled: !current.enabled };
      await PimSettings.set("tps", next);
      ctx.ui.notify(
        `TPS reporting ${next.enabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  });

  let requestSentMs: number | null = null;
  const firstTokenByMessage = new WeakMap<AssistantMessage, number>();

  let promptTokens = 0;
  let prefillMs = 0;
  let outputTokens = 0;
  let decodeMs = 0;
  let cacheReadTokens = 0;
  let firstTtftMs: number | null = null;

  pi.on("turn_start", () => {
    promptTokens = 0;
    prefillMs = 0;
    outputTokens = 0;
    decodeMs = 0;
    cacheReadTokens = 0;
    firstTtftMs = null;
  });

  pi.on("before_provider_request", () => {
    requestSentMs = Date.now();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") {
      return;
    }
    if (firstTokenByMessage.has(event.message)) {
      return;
    }
    firstTokenByMessage.set(event.message, Date.now());
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") {
      return;
    }

    const firstTokenMs = firstTokenByMessage.get(event.message);
    const sentMs = requestSentMs;
    requestSentMs = null;
    if (firstTokenMs === undefined || sentMs === null) {
      return;
    }

    const usage = event.message.usage;
    const ttft = firstTokenMs - sentMs;
    const decode = Date.now() - firstTokenMs;

    if (firstTtftMs === null && ttft > 0) {
      firstTtftMs = ttft;
    }

    const prefillCounted = (usage.input ?? 0) + (usage.cacheWrite ?? 0);
    if (prefillCounted > 0 && ttft > 0) {
      promptTokens += prefillCounted;
      prefillMs += ttft;
    }
    if ((usage.output ?? 0) > 0 && decode > 0) {
      outputTokens += usage.output;
      decodeMs += decode;
    }
    cacheReadTokens += usage.cacheRead ?? 0;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    if (decodeMs <= 0 && prefillMs <= 0) {
      return;
    }
    const { enabled } = await PimSettings.get("tps");
    if (!enabled) {
      return;
    }

    const decodeTps = decodeMs > 0 ? outputTokens / (decodeMs / 1000) : 0;
    const prefillTps = prefillMs > 0 ? promptTokens / (prefillMs / 1000) : 0;
    const ttftSec = firstTtftMs !== null ? firstTtftMs / 1000 : 0;

    const parts = [
      `Decode: ${decodeTps.toFixed(1)} tps`,
      `Prefill: ${prefillTps.toFixed(1)} tps`,
    ];
    if (cacheReadTokens > 0) {
      parts.push(`Cache read: ${cacheReadTokens.toLocaleString()}`);
    }
    parts.push(`TTFT: ${ttftSec.toFixed(2)}s`);

    ctx.ui.notify(parts.join(" | "), "info");
  });
}
