import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";

import { MessageText } from "#core/session/MessageText";
import { Errors } from "#core/shared/Errors";
import { Renderer, type TurnEndState } from "./Renderer";
import type { Session } from "./Session";

type FinalResult = {
  readonly text: string;
  readonly state: TurnEndState;
};

/** Renders one agent run in the session's chat. `start` begins the run: a prompt, or a job result that wakes the agent; events outside a run, like a result appended without one, render nothing. */
async function run(
  session: Session,
  api: Api,
  agent: AgentSession,
  start: (agent: AgentSession) => Promise<void>
): Promise<void> {
  const renderer = new Renderer(session, api);
  let running = false;
  let settled: { readonly aborted: boolean } | undefined;
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "agent_start" || event.type === "compaction_start") {
      running = true;
      renderer.start();
    }
    if (!running) {
      return;
    }
    if (event.type === "agent_settled") {
      settled = { aborted: event.aborted };
    }
    renderer.handleEvent(event);
  });
  try {
    await start(agent);
    const final: FinalResult =
      settled === undefined ? { text: "", state: "ok" } : finalResult(agent);
    if (settled?.aborted === true && final.state === "ok") {
      await renderer.finish("", "cancelled");
    } else {
      await renderer.finish(final.text, final.state);
    }
  } catch (err) {
    console.error(`[bot] turn failed:`, err);
    await renderer.finish(`⚠️ ${Errors.describe(err)}`, "error");
  } finally {
    unsubscribe();
  }
}

function finalResult(agent: AgentSession): FinalResult {
  const messages = agent.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") {
      continue;
    }
    if (msg.stopReason === "error") {
      return { text: msg.errorMessage ?? "", state: "error" };
    }
    if (msg.stopReason === "aborted") {
      return { text: msg.errorMessage ?? "", state: "cancelled" };
    }
    return { text: MessageText.textOf(msg.content).trim(), state: "ok" };
  }
  return { text: "", state: "ok" };
}

export const Turn = { run };
