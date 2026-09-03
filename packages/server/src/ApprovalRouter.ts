import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

import { Paths } from "../../core/src/shared/Paths";
import { Tools } from "../../core/src/shared/Tools";

/** A tool call waiting for a human, keyed on pi's tool call id. */
export type ApprovalRequest = {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  /** Why the policy could not decide on its own, in plain words. */
  readonly reason: string;
};

export type ApprovalOutcome = {
  readonly approved: boolean;
  readonly reason: string;
};

/**
 * Which of the three tiers of the approval policy a call landed in. Tiers 1
 * and 2 run unattended; tier 3 blocks the turn until someone answers.
 */
export type ApprovalClassification = {
  readonly tier: 1 | 2 | 3;
  readonly reason: string;
};

export type ApprovalResolveResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export type ApprovalRouterDeps = {
  /** Read per call: a session's cwd can move between turns. */
  readonly cwd: () => string;
  readonly onRequest: (request: ApprovalRequest) => void;
  readonly onResolved: (
    request: ApprovalRequest,
    outcome: ApprovalOutcome
  ) => void;
};

/**
 * The only part of pi's session the router touches. Structural so the policy
 * can be driven without a live agent behind it.
 */
export type ToolGate = {
  readonly agent: {
    beforeToolCall?: (
      context: BeforeToolCallContext,
      signal?: AbortSignal
    ) => Promise<BeforeToolCallResult | undefined>;
  };
};

type Pending = {
  readonly request: ApprovalRequest;
  readonly settle: (outcome: ApprovalOutcome) => void;
  readonly detach: () => void;
};

/** How many settled decisions are remembered to answer a late second client. */
const RECENT_CAP = 64;

/**
 * The approval policy for one session, as an async request/response over the
 * wire instead of a modal prompt.
 *
 * Read-only tools and writes that land inside the session cwd run unattended;
 * everything else blocks the turn until a client answers. That asymmetry is
 * the point: queueing every call would mean an agent can only work while
 * somebody is watching, which is precisely what this architecture exists to
 * avoid.
 *
 * Blocking is per session. Pi awaits `beforeToolCall` inside one agent's loop,
 * every session owns its own agent and its own turn queue, and the gateway
 * never awaits a turn — so a session parked on a question costs that session's
 * progress and nothing else.
 */
export class ApprovalRouter {
  private readonly deps: ApprovalRouterDeps;
  private readonly pendingByCall = new Map<string, Pending>();
  private readonly recent = new Map<string, ApprovalOutcome>();
  private disposed = false;

  public constructor(deps: ApprovalRouterDeps) {
    this.deps = deps;
  }

  public get pending(): readonly ApprovalRequest[] {
    return [...this.pendingByCall.values()].map((entry) => entry.request);
  }

  /**
   * Take over the session's tool gate. `Agent.beforeToolCall` is a public
   * mutable hook that `AgentSession` installs once in its constructor and
   * never reinstalls (extension reload swaps the runner behind it), so
   * wrapping it here composes with pi's own `tool_call` extension bridge
   * instead of replacing it, and survives `reload()`.
   */
  public install(gate: ToolGate): () => void {
    const inner = gate.agent.beforeToolCall;
    gate.agent.beforeToolCall = async (context, signal) => {
      const blocked = await this.gate(
        context.toolCall.id,
        context.toolCall.name,
        context.args,
        signal
      );
      return blocked ?? (await inner?.(context, signal));
    };
    return () => {
      gate.agent.beforeToolCall = inner;
    };
  }

  public async classify(
    name: string,
    args: unknown
  ): Promise<ApprovalClassification> {
    const effect = Tools.effectOf(name);
    if (effect?.kind === "readOnly") {
      return { tier: 1, reason: `${name} only reads` };
    }
    if (effect?.kind === "writesPaths" && effect.paths) {
      return await this.classifyPaths(name, effect.paths, args);
    }
    return {
      tier: 3,
      reason: effect
        ? `${name} can act outside the session directory`
        : `${name} does not declare what it can touch`,
    };
  }

  /**
   * First decision wins. A second client answering the same call is told the
   * question is already settled rather than silently re-deciding a turn that
   * has long since moved on.
   */
  public resolve(
    callId: string,
    approved: boolean,
    reason?: string
  ): ApprovalResolveResult {
    const entry = this.pendingByCall.get(callId);
    if (!entry) {
      const settled = this.recent.get(callId);
      return {
        ok: false,
        error: settled
          ? `approval for ${callId} was already resolved: ${settled.reason}`
          : `no approval is pending for ${callId}`,
      };
    }
    this.settle(entry, {
      approved,
      reason:
        reason ?? (approved ? "approved by a client" : "denied by a client"),
    });
    return { ok: true };
  }

  /** Frees every blocked turn; further calls are denied rather than queued. */
  public dispose(): void {
    this.disposed = true;
    for (const entry of this.pendingByCall.values()) {
      this.settle(entry, {
        approved: false,
        reason: "the session stopped waiting for an answer",
      });
    }
  }

  private async gate(
    callId: string,
    name: string,
    args: unknown,
    signal: AbortSignal | undefined
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    const classification = await this.classify(name, args);
    if (classification.tier !== 3) {
      return undefined;
    }
    if (this.disposed) {
      return { block: true, reason: "the session is shutting down" };
    }
    if (signal?.aborted) {
      return { block: true, reason: "the turn was aborted" };
    }
    // Pi's call ids are unique; overwriting a live entry would strand the turn
    // waiting on it, so refuse rather than risk a hang if that ever changes.
    if (this.pendingByCall.has(callId)) {
      return { block: true, reason: `${callId} is already awaiting approval` };
    }
    const outcome = await this.queue(
      { callId, name, args, reason: classification.reason },
      signal
    );
    return outcome.approved
      ? undefined
      : { block: true, reason: outcome.reason };
  }

  private queue(
    request: ApprovalRequest,
    signal: AbortSignal | undefined
  ): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      // Cancelling the turn must free it even with nobody attached, otherwise
      // an unanswered question outlives the work it was asked about.
      const onAbort = (): void => {
        this.resolve(request.callId, false, "the turn was aborted");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingByCall.set(request.callId, {
        request,
        settle: resolve,
        detach: () => {
          signal?.removeEventListener("abort", onAbort);
        },
      });
      this.deps.onRequest(request);
    });
  }

  private settle(entry: Pending, outcome: ApprovalOutcome): void {
    this.pendingByCall.delete(entry.request.callId);
    entry.detach();
    this.remember(entry.request.callId, outcome);
    entry.settle(outcome);
    this.deps.onResolved(entry.request, outcome);
  }

  private remember(callId: string, outcome: ApprovalOutcome): void {
    this.recent.set(callId, outcome);
    while (this.recent.size > RECENT_CAP) {
      const oldest = this.recent.keys().next();
      if (oldest.done) {
        return;
      }
      this.recent.delete(oldest.value);
    }
  }

  private async classifyPaths(
    name: string,
    paths: (args: unknown) => readonly string[],
    args: unknown
  ): Promise<ApprovalClassification> {
    let targets: readonly string[];
    try {
      targets = paths(args);
    } catch (err) {
      return {
        tier: 3,
        reason: `${name} target paths are undeterminable: ${(err as Error).message}`,
      };
    }
    if (targets.length === 0) {
      return { tier: 3, reason: `${name} named no target path` };
    }
    const cwd = this.deps.cwd();
    const root = await canonicalize(cwd, cwd);
    for (const target of targets) {
      const resolved = await canonicalize(target, cwd);
      if (!isInside(resolved, root)) {
        return {
          tier: 3,
          reason: `${name} would write ${resolved}, outside ${root}`,
        };
      }
    }
    return {
      tier: 2,
      reason: `${name} writes only inside ${root}`,
    };
  }
}

/**
 * The path the OS would actually open, resolved one segment at a time so a
 * symlink is followed *before* the `..` that follows it — the order the kernel
 * uses and the order `path.resolve` gets wrong. Segments that do not exist yet
 * (a file about to be created) are appended literally.
 */
async function canonicalize(target: string, cwd: string): Promise<string> {
  const expanded = Paths.expandHome(target);
  const base = isAbsolute(expanded) ? parse(expanded).root : cwd;
  let current = (await realpath(base).catch(() => undefined)) ?? base;
  for (const segment of expanded.split(sep)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    current = (await realpath(next).catch(() => undefined)) ?? next;
  }
  return current;
}

function isInside(target: string, root: string): boolean {
  if (target === root) {
    return true;
  }
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
