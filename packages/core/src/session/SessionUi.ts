import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";

import type { NoticeSeverity } from "../view/ViewBlock";

/** The subset of pi's dialog options a non-terminal surface honours. */
export type UiAsk = {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
};

/** The parts of pi's `ExtensionUIContext` a non-terminal surface implements. */
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

const IDENTITY = (text: string): string => text;

const DEFAULT_COLOR = { kind: "indexed", index: 7 } as const;

/** `satisfies` checks every public member, so a method pi adds is a type error here. */
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
  appearance: "dark",
  colors: new Proxy({}, { get: () => DEFAULT_COLOR }) as Theme["colors"],
  style: IDENTITY,
} satisfies { [K in keyof Theme]: Theme[K] } as unknown as Theme;

function severityOf(
  kind: Parameters<ExtensionUIContext["notify"]>[1]
): NoticeSeverity {
  return kind === "warning" ? "warn" : (kind ?? "info");
}

/** A failing sink answers `undefined` instead of throwing. */
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
 * Adapts a sink to pi's `ExtensionUIContext`; terminal-only methods are no-ops,
 * as in pi's RPC mode. `sink` is read per call.
 *
 * Must be a plain object: pi copies it with `{ ...ui }`, which drops prototype methods.
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
