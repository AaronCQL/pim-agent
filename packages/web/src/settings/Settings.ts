import {
  createContext,
  createStore,
  type Store,
  type StoreSetter,
} from "solid-js";

import { SplitMode } from "../diff/SplitMode";

const KEY = "pim.settings";
const DEV_PORT = 4319;

type Preferences = {
  serverUrl: string;
  hideThinking: boolean;
  diffSplit: SplitMode;
};

/** Defaults to showing thinking outside the shell. */
export const HideThinking = createContext<() => boolean>(() => false);

/** Per-browser preferences, persisted to localStorage. */
export class Settings {
  public readonly state: Store<Preferences>;
  private readonly setState: StoreSetter<Preferences>;
  // Synchronous copy of `state`; store writes only land on the next flush.
  private current: Preferences;

  public constructor() {
    this.current = read();
    const [state, setState] = createStore<Preferences>({ ...this.current });
    this.state = state;
    this.setState = setState;
  }

  /** Falls back to this origin when the URL is empty or invalid. */
  public gateway(): string {
    const typed = this.current.serverUrl;
    return (typed === "" ? undefined : socketUrl(typed)) ?? origin();
  }

  /** A `ws://` gateway from an `https://` page, which the browser blocks. */
  public insecure(): boolean {
    return location.protocol === "https:" && this.gateway().startsWith("ws:");
  }

  public setServerUrl(url: string): void {
    this.apply({ ...this.current, serverUrl: url.trim() });
  }

  public setHideThinking(hide: boolean): void {
    this.apply({ ...this.current, hideThinking: hide });
  }

  public setDiffSplit(mode: SplitMode): void {
    this.apply({ ...this.current, diffSplit: mode });
  }

  private apply(next: Preferences): void {
    this.current = next;
    this.setState((state) => {
      state.serverUrl = next.serverUrl;
      state.hideThinking = next.hideThinking;
      state.diffSplit = next.diffSplit;
    });
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Private mode or full quota; keep the in-memory value.
    }
  }
}

function read(): Preferences {
  try {
    const saved = JSON.parse(
      localStorage.getItem(KEY) ?? "null"
    ) as Partial<Preferences> | null;
    return {
      serverUrl:
        typeof saved?.serverUrl === "string" ? saved.serverUrl.trim() : "",
      hideThinking: saved?.hideThinking === true,
      diffSplit: SplitMode.parse(saved?.diffSplit),
    };
  } catch {
    return { serverUrl: "", hideThinking: false, diffSplit: "auto" };
  }
}

function origin(): string {
  const override = import.meta.env.VITE_PIM_SERVER;
  if (override !== undefined && override !== "") {
    return override;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const host = import.meta.env.DEV
    ? `${location.hostname}:${DEV_PORT}`
    : location.host;
  return `${protocol}//${host}`;
}

const SOCKET_SCHEMES: Record<string, string> = {
  "http:": "ws:",
  "https:": "wss:",
  "ws:": "ws:",
  "wss:": "wss:",
};

// Built by hand: the URL `protocol` setter refuses some scheme changes.
function socketUrl(typed: string): string | undefined {
  const secure = location.protocol === "https:";
  const url = URL.parse(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(typed)
      ? typed
      : `${secure ? "wss" : "ws"}://${typed}`
  );
  const scheme = url && SOCKET_SCHEMES[url.protocol];
  if (!url || scheme === undefined) {
    return undefined;
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${scheme}//${url.host}${path}`;
}
