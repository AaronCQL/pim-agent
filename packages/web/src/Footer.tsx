import { Show } from "solid-js";

import type { SessionStatus } from "../../protocol/src/ServerEvent";
import type { ConnectionStatus } from "./ws/WsClient";
import type { SessionStore } from "./session/SessionStore";

const AGENT_LABELS: Record<SessionStatus, string> = {
  idle: "idle",
  thinking: "thinking",
  streaming: "streaming",
  tool: "running tool",
};

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: "connecting…",
  open: "live",
  reconnecting: "reconnecting…",
  closed: "offline",
};

/**
 * The raw `session_state` fields, painted. The server emits numbers and a
 * status word; how a frontend draws them is entirely its own business, which
 * is why there is no spinner on the wire.
 */
export function Footer(props: { readonly store: SessionStore }) {
  const state = () => props.store.state;

  return (
    <footer class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-800 pt-2 font-mono text-xs text-neutral-500">
      <span
        class={{
          "flex items-center gap-1": true,
          "text-emerald-400": state().connection === "open",
          "text-amber-400": state().connection === "reconnecting",
          "text-red-400": state().connection === "closed",
        }}
      >
        <span class="i-lucide-radio block" aria-hidden="true" />
        {CONNECTION_LABELS[state().connection]}
      </span>
      <span>{AGENT_LABELS[state().agent]}</span>
      <Show when={state().model}>
        <span class="text-neutral-400">{state().model}</span>
      </Show>
      <Show when={state().tps !== undefined}>
        <span>{`${Math.round(state().tps ?? 0)} tok/s`}</span>
      </Show>
      <Show when={state().cost > 0}>
        <span>{`$${state().cost.toFixed(4)}`}</span>
      </Show>
      <span class="ml-auto">{`seq ${state().durable.at(-1)?.seq ?? 0}`}</span>
      <Show when={state().error}>
        {(message) => <span class="w-full text-red-400">{message()}</span>}
      </Show>
    </footer>
  );
}
