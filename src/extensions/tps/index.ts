import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";

type RequestTiming = {
  readonly sentMs: number;
  firstOutputMs: number | null;
};

function isOutputEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "text_end":
    case "thinking_end":
      return event.content.length > 0;
    case "toolcall_end":
      return true;
    default:
      return false;
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("tps", {
    description: "Toggle per-cycle decode/prefill tps reporting",
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

  let requestTiming: RequestTiming | null = null;

  let promptTokens = 0;
  let prefillMs = 0;
  let outputTokens = 0;
  let decodeMs = 0;
  let cacheReadTokens = 0;
  let firstTtftMs: number | null = null;

  pi.on("agent_start", () => {
    promptTokens = 0;
    prefillMs = 0;
    outputTokens = 0;
    decodeMs = 0;
    cacheReadTokens = 0;
    firstTtftMs = null;
  });

  pi.on("before_provider_request", () => {
    requestTiming = {
      sentMs: Date.now(),
      firstOutputMs: null,
    };
  });

  pi.on("message_update", (event) => {
    if (
      event.message.role === "assistant" &&
      requestTiming !== null &&
      requestTiming.firstOutputMs === null &&
      isOutputEvent(event.assistantMessageEvent)
    ) {
      requestTiming.firstOutputMs = Date.now();
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") {
      return;
    }

    const timing = requestTiming;
    const endedMs = Date.now();
    requestTiming = null;
    if (timing === null) {
      return;
    }

    const usage = event.message.usage;
    const responseMs = timing.firstOutputMs ?? endedMs;
    const ttft = responseMs - timing.sentMs;
    const decode = endedMs - responseMs;

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

  pi.on("agent_end", async (_event, ctx) => {
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
