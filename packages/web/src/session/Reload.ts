import { createStore, type Store, type StoreSetter } from "solid-js";

import type { ServerEvent, UpdateStateEvent } from "#protocol/ServerEvent";
import type { AttachTarget, ConnectionStatus } from "../ws/WsClient";

export type ReloadNotice = {
  readonly tone: "success" | "warning" | "error";
  readonly text: string;
  /**
   * The notice names a step the reader can take here. Only ever a reload:
   * a tab the server has moved on from is repaired by fetching this page
   * again, and nothing else on screen can do that for them.
   */
  readonly action?: "reload";
};

type Intent = {
  readonly deadline: number;
  readonly phase: "updating" | "restarting" | "loaded";
  readonly target: AttachTarget;
  readonly skipped: string;
  /** Whether any skip left the operator something to do; see `UpdateSkip`. */
  readonly blocking: boolean;
};

type State = {
  pending: boolean;
  label: string;
  notice: ReloadNotice | undefined;
  /**
   * The reader has closed what was on screen. Kept apart from `notice` so a
   * dismissal can also silence the progress line, which is not a notice and
   * outlives any one of them: `pending` still gates the restart button while
   * this is true. Every step the machine takes afterwards clears it, so the
   * toast reporting how the update ended is not swallowed by a tap on the
   * one that said it had started.
   */
  dismissed: boolean;
};

const TIMEOUT_MS = 180_000;
const DISMISS_MS = 10_000;
const TIMEOUT_NOTICE: ReloadNotice = {
  tone: "warning",
  text: "Restart timed out. The server may still be updating; check it before trying again.",
};

/** Per-tab intent, not a reconnect policy: only the requesting tab navigates. */
export class Reload {
  public readonly state: Store<State>;
  public readonly target: AttachTarget | undefined;
  private readonly setState: StoreSetter<State>;
  private readonly key: string;
  private readonly reloadPage: () => void;
  private intent: Intent | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dismissTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnected: boolean;
  private navigating: boolean;

  public constructor(url: string, reloadPage = () => location.reload()) {
    this.key = `pim.reload:${url}`;
    this.reloadPage = reloadPage;
    const saved = readIntent(this.key);
    const expired = saved !== undefined && saved.deadline <= Date.now();
    this.intent = expired ? undefined : saved;
    this.target = this.intent?.target;
    this.disconnected = this.intent?.phase === "restarting";
    this.navigating = false;
    this.timer = undefined;
    const [state, setState] = createStore<State>({
      pending: this.intent !== undefined,
      label: this.intent ? "Waiting for server…" : "",
      notice: expired ? TIMEOUT_NOTICE : undefined,
      dismissed: false,
    });
    this.state = state;
    this.setState = setState;
    if (expired) {
      this.persist();
    }
    if (this.intent) {
      this.arm(this.intent.deadline);
    }
  }

  public begin(target: AttachTarget): boolean {
    if (this.timer !== undefined || this.navigating) {
      return false;
    }
    this.intent = {
      deadline: Date.now() + TIMEOUT_MS,
      phase: "updating",
      target,
      skipped: "",
      blocking: false,
    };
    this.disconnected = false;
    this.persist();
    this.progress("Updating…");
    this.arm(this.intent.deadline);
    return true;
  }

  public rejected(error: string): void {
    if (this.intent?.phase === "updating") {
      this.finish({ tone: "error", text: error });
    }
  }

  public connection(status: ConnectionStatus): void {
    if (this.navigating) {
      return;
    }
    if (status === "outdated") {
      if (this.intent && this.intent.phase !== "loaded") {
        this.refresh();
      } else {
        this.finish({
          tone: "warning",
          text: "This tab is outdated. Reload the page to use the current client.",
          action: "reload",
        });
      }
      return;
    }
    if (status === "reconnecting") {
      this.disconnected = true;
    }
    // Socket open is enough: an unwritten session may no longer exist, so
    // waiting for its attach to succeed would strand the old bundle here.
    if (status === "open" && this.disconnected) {
      if (this.intent?.phase === "restarting") {
        this.refresh();
      } else if (!this.intent && this.timer !== undefined) {
        this.finish({
          tone: "warning",
          text: "Server reconnected. Reload the page to use the current client.",
          action: "reload",
        });
      }
    }
  }

  public ingest(event: ServerEvent): void {
    // Navigation is asynchronous; the old socket must not consume the toast
    // intended for the next page while its document is still unloading.
    if (this.navigating) {
      return;
    }
    if (event.type === "attached") {
      if (this.intent?.phase === "loaded") {
        const { skipped, blocking } = this.intent;
        this.finish({
          tone: blocking ? "warning" : "success",
          text: `Restarted with pim ${event.pimVersion}.${skipped}`,
        });
      }
      return;
    }
    if (event.type !== "update_state") {
      return;
    }
    switch (event.phase) {
      case "step":
        this.progress(event.label);
        if (this.timer === undefined) {
          this.arm(Date.now() + TIMEOUT_MS);
        }
        return;
      case "restarting":
        if (this.intent) {
          this.intent = {
            ...this.intent,
            phase: "restarting",
            skipped: skips(event),
            blocking: event.skipped.some((skip) => skip.blocking),
          };
          this.persist();
        }
        this.progress("Restarting…");
        if (this.timer === undefined) {
          this.arm(Date.now() + TIMEOUT_MS);
        }
        return;
      case "stranded":
        this.finish({
          tone: "warning",
          text: `Updated on disk to pim ${event.to}, but this server is not supervised. Restart it manually, then reload this page.${skips(event)}`,
        });
        return;
      case "failed":
        this.finish({ tone: "error", text: `Update failed: ${event.error}` });
    }
  }

  public refresh(): void {
    if (this.navigating) {
      return;
    }
    this.navigating = true;
    if (this.intent) {
      this.intent = { ...this.intent, phase: "loaded" };
      this.persist();
    }
    this.dispose();
    this.reloadPage();
  }

  public dismiss(): void {
    clearTimeout(this.dismissTimer);
    this.dismissTimer = undefined;
    this.setState((state) => {
      state.notice = undefined;
      state.dismissed = true;
    });
  }

  public dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.dismissTimer);
    this.timer = undefined;
    this.dismissTimer = undefined;
  }

  private progress(label: string): void {
    this.setState((state) => {
      state.pending = true;
      state.label = label;
      state.notice = undefined;
      state.dismissed = false;
    });
  }

  private arm(deadline: number): void {
    this.timer = setTimeout(
      () => this.finish(TIMEOUT_NOTICE),
      Math.max(0, deadline - Date.now())
    );
  }

  private finish(notice: ReloadNotice): void {
    this.dispose();
    this.intent = undefined;
    this.persist();
    this.setState((state) => {
      state.pending = false;
      state.label = "";
      state.notice = notice;
      state.dismissed = false;
    });
    // Only a success is purely informational; a warning or an error names the
    // manual step still owed, so it stays until the reader dismisses it.
    if (notice.tone === "success") {
      this.dismissTimer = setTimeout(() => this.dismiss(), DISMISS_MS);
    }
  }

  private persist(): void {
    try {
      if (this.intent) {
        sessionStorage.setItem(this.key, JSON.stringify(this.intent));
      } else {
        sessionStorage.removeItem(this.key);
      }
    } catch {
      // Storage can be denied; the live restart still works without a toast
      // carried across the navigation.
    }
  }
}

function readIntent(key: string): Intent | undefined {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(key) ?? "null"
    ) as Intent | null;
    if (
      saved &&
      Number.isFinite(saved.deadline) &&
      ["updating", "restarting", "loaded"].includes(saved.phase) &&
      typeof saved.skipped === "string" &&
      saved.target &&
      (saved.target.sessionId === undefined ||
        typeof saved.target.sessionId === "string") &&
      (saved.target.cwd === undefined || typeof saved.target.cwd === "string")
    ) {
      // The bundle that wrote this one may predate `blocking` — the update to
      // this very build is that case — so an absent flag reads as a note
      // rather than discarding the toast the operator is waiting for.
      return { ...saved, blocking: saved.blocking === true };
    }
  } catch {
    // A stale or unavailable storage entry must not prevent opening a chat.
  }
  return undefined;
}

function skips(
  event: Extract<UpdateStateEvent, { phase: "restarting" | "stranded" }>
): string {
  return event.skipped
    .map(({ label, reason }) => ` Skipped ${label}: ${reason}.`)
    .join("");
}
