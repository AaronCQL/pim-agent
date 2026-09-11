import {
  createContext,
  createStore,
  type Store,
  type StoreSetter,
} from "solid-js";

const KEY = "pim.settings";
/** Where `pim-server` listens when the page itself came from Vite. */
const DEV_PORT = 4319;

type Preferences = {
  /**
   * Which machine to drive. Empty is the one that served this page, which is
   * what every install that is not being reached across a network wants —
   * stored as the empty string rather than as the resolved address so that a
   * tab left open keeps following its origin instead of pinning the hostname
   * it happened to be opened on.
   */
  serverUrl: string;
  hideThinking: boolean;
};

/**
 * Whether the transcript paints what the model thought, read where the
 * thinking is drawn rather than passed down to it: the transcript is mounted
 * in two places — the session and the subagent modal — and neither of the
 * things between them has any other reason to know this preference exists.
 *
 * Defaulted rather than default-less, so a transcript rendered outside the
 * shell (a test, a fixture) shows everything instead of throwing.
 */
export const HideThinking = createContext<() => boolean>(() => false);

/**
 * What this browser remembers, as opposed to what the server knows: where to
 * connect and what to draw. Neither is a fact about any session, so neither
 * goes near `SessionStore` — nothing here is ever sent anywhere.
 *
 * Persisted whole under one key, because the pair is small and read exactly
 * once, at boot, before there is a socket to be reactive about.
 */
export class Settings {
  /** The reactive view, for anything that paints a preference. */
  public readonly state: Store<Preferences>;
  private readonly setState: StoreSetter<Preferences>;
  /**
   * The same values, written synchronously. A store write only lands on the
   * next flush, and both the address to connect to and the bytes to persist
   * are read in the same breath as the write that changed them.
   */
  private current: Preferences;

  public constructor() {
    this.current = read();
    const [state, setState] = createStore<Preferences>({ ...this.current });
    this.state = state;
    this.setState = setState;
  }

  /**
   * The socket address to open, which is the only form of the setting that
   * anything else may use. A typed address is a courtesy to the person who
   * typed it — `laptop:4319`, `http://laptop:4319` and `ws://laptop:4319` all
   * mean the same machine — and one that cannot be read at all falls back to
   * this origin rather than leaving the app with nowhere to connect.
   */
  public gateway(): string {
    const typed = this.current.serverUrl;
    return (typed === "" ? undefined : socketUrl(typed)) ?? origin();
  }

  /**
   * A `ws://` gateway named from an `https://` page. The browser blocks the
   * socket outright and reports it only to the console, so this is the one
   * misconfiguration the modal has to name itself: every symptom of it looks
   * exactly like a server that is switched off.
   */
  public insecure(): boolean {
    return location.protocol === "https:" && this.gateway().startsWith("ws:");
  }

  public setServerUrl(url: string): void {
    this.apply({ ...this.current, serverUrl: url.trim() });
  }

  public setHideThinking(hide: boolean): void {
    this.apply({ ...this.current, hideThinking: hide });
  }

  private apply(next: Preferences): void {
    this.current = next;
    this.setState((state) => {
      state.serverUrl = next.serverUrl;
      state.hideThinking = next.hideThinking;
    });
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Private mode or a full quota. Both preferences hold for this tab's
      // life either way; only remembering them is lost.
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
    };
  } catch {
    return { serverUrl: "", hideThinking: false };
  }
}

/** The server that served this page, or whatever the build was pointed at. */
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

/**
 * Assembled from the parsed parts rather than by assigning `protocol`, whose
 * setter has its own rules about which schemes may become which.
 */
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
