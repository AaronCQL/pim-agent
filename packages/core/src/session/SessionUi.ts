import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";

import type { NoticeSeverity } from "../view/ViewBlock";

/** The slice of pi's dialog options a surface without a terminal can honour; the rest is countdown chrome. */
export type UiAsk = {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
};

/** Where an extension's own words go. Four of pi's thirty methods: the ones that address a human rather than a terminal. */
export type SessionUi = {
  readonly notify: (text: string, severity: NoticeSeverity) => void;
  readonly select: (
    title: string,
    options: readonly string[],
    opts?: UiAsk
  ) => Promise<string | undefined>;
  readonly confirm: (
    title: string,
    message: string,
    opts?: UiAsk
  ) => Promise<boolean>;
  readonly input: (
    title: string,
    placeholder?: string,
    opts?: UiAsk
  ) => Promise<string | undefined>;
};

/** Everything off the terminal paints with; also what pi's border getters hand back. */
const IDENTITY = (text: string): string => text;

/**
 * pi keeps its own `theme` instance to itself, and nothing off the terminal has
 * colours to paint with. `satisfies` covers the whole public surface — `keyof`
 * skips the private fields the cast is for — so a method pi adds is a type
 * error here rather than a throw inside somebody's event handler.
 */
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: IDENTITY,
  italic: IDENTITY,
  underline: IDENTITY,
  inverse: IDENTITY,
  strikethrough: IDENTITY,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => IDENTITY,
  getBashModeBorderColor: () => IDENTITY,
} satisfies { [K in keyof Theme]: Theme[K] } as unknown as Theme;

function severityOf(
  kind: Parameters<ExtensionUIContext["notify"]>[1]
): NoticeSeverity {
  return kind === "warning" ? "warn" : (kind ?? "info");
}

/** A dialog an extension awaits goes unanswered rather than ever throwing at it. */
async function settle<T>(
  ask: () => Promise<T> | undefined
): Promise<T | undefined> {
  try {
    return await ask();
  } catch (err) {
    console.warn("[SessionUi] dialog sink failed:", err);
    return undefined;
  }
}

/**
 * Widens the sink onto pi's `ExtensionUIContext`, no-opping everything a
 * terminal owns exactly as pi's own RPC mode does. `sink` is read per call, so
 * an agent rebuilt under a host keeps whatever its host was last handed.
 *
 * Every method has to be an *own* property: pi re-wraps what it is given with
 * `{ ...ui }` (`runner.js:274`), which copies own enumerable keys only. A class
 * instance would arrive with `notify` and the rest of the prototype missing.
 */
export function adaptSessionUi(
  sink: () => SessionUi | undefined
): ExtensionUIContext {
  return {
    select: (title, options, opts) =>
      settle(() => sink()?.select(title, options, opts)),
    confirm: async (title, message, opts) =>
      (await settle(() => sink()?.confirm(title, message, opts))) === true,
    input: (title, placeholder, opts) =>
      settle(() => sink()?.input(title, placeholder, opts)),
    notify: (message, kind) => {
      try {
        sink()?.notify(message, severityOf(kind));
      } catch (err) {
        console.warn("[SessionUi] notify sink failed:", err);
      }
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>() => undefined as T,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: PLAIN_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "UI not available" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}
