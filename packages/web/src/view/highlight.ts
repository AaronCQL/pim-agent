import { createSignal } from "solid-js";

import type hljsCore from "highlight.js/lib/core";

/**
 * The nine roles a theme colours, which are pi's `syntax*` theme keys. The
 * TUI highlights through `cli-highlight`, which folds highlight.js's ~40
 * scopes onto exactly these; `SCOPES` below is that same folding, so a line
 * of TypeScript is cut into the same pieces here as it is in the terminal and
 * only the palette differs.
 */
export type SyntaxRole =
  | "keyword"
  | "type"
  | "function"
  | "variable"
  | "string"
  | "number"
  | "comment"
  | "meta"
  | "operator"
  | "punctuation";

/** A run of code carrying one role; no role means it reads as plain code. */
export type Token = {
  readonly text: string;
  readonly role?: SyntaxRole;
};

/** highlight.js scope → role, transcribed from pi's `buildCliHighlightTheme`. */
const SCOPES: Readonly<Record<string, SyntaxRole>> = {
  keyword: "keyword",
  name: "keyword",
  built_in: "type",
  class_: "type",
  class: "type",
  type: "type",
  title: "function",
  function_: "function",
  function: "function",
  literal: "number",
  number: "number",
  string: "string",
  regexp: "string",
  subst: "variable",
  comment: "comment",
  doctag: "comment",
  meta: "meta",
  attr: "variable",
  attribute: "variable",
  property: "variable",
  variable: "variable",
  params: "variable",
  operator: "operator",
  tag: "punctuation",
  punctuation: "punctuation",
};

/**
 * The grammars the client can fetch, each its own chunk: a transcript full of
 * TypeScript should not also download Erlang. Keyed by the ids
 * `Languages.resolve` produces, so anything that table can name is either
 * loadable here or deliberately left plain.
 */
const GRAMMARS: Readonly<Record<string, () => Promise<unknown>>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  clojure: () => import("highlight.js/lib/languages/clojure"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  erlang: () => import("highlight.js/lib/languages/erlang"),
  // No fish grammar ships with highlight.js; bash is close enough that a
  // script reads right, and wrong enough to be worth saying so.
  fish: () => import("highlight.js/lib/languages/bash"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  html: () => import("highlight.js/lib/languages/xml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  md: () => import("highlight.js/lib/languages/markdown"),
  ocaml: () => import("highlight.js/lib/languages/ocaml"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  toml: () => import("highlight.js/lib/languages/ini"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  vim: () => import("highlight.js/lib/languages/vim"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/**
 * Bumped whenever a grammar finishes loading. Every `tokenize` call reads it,
 * so a block painted plain because its language had not arrived yet repaints
 * itself the moment it does — which is the whole price of loading grammars on
 * demand, one frame of unhighlighted code.
 */
const [loaded, setLoaded] = createSignal(0);

/** Languages already fetched, and the ones whose fetch failed or is in flight. */
const registered = new Set<string>();
const pending = new Set<string>();

type Grammar = { readonly default: unknown };

/**
 * The engine itself is fetched with the first grammar, not with the app: a
 * session that is all prose and shell output never pays for a highlighter it
 * has nothing to point at.
 */
let hljs: typeof hljsCore | undefined;

async function load(lang: string): Promise<void> {
  const grammar = GRAMMARS[lang];

  if (grammar === undefined) {
    return;
  }

  const [core, module] = await Promise.all([
    hljs ?? import("highlight.js/lib/core").then((core) => core.default),
    grammar(),
  ]);

  hljs = core;
  // `registerLanguage` wants the definition function highlight.js's own
  // language modules default-export.
  core.registerLanguage(lang, (module as Grammar).default as never);
  registered.add(lang);
  setLoaded((version) => version + 1);
}

function request(lang: string): void {
  if (pending.has(lang)) {
    return;
  }

  pending.add(lang);
  void load(lang).catch(() => {
    // A grammar that will not load is a block that stays plain; a transcript
    // is still perfectly readable without colour.
  });
}

/**
 * `code` cut into one token list per line.
 *
 * Whole blocks go in, not lines: highlight.js has to see a block comment or a
 * template literal open and close to tokenise the lines between them, and it
 * emits spans that cross newlines to say so. Splitting those spans back into
 * lines is this function's other half, and is why callers get tokens instead
 * of the HTML highlight.js would rather hand them.
 *
 * Reactive: called inside a memo, it re-runs once the language lands.
 */
function tokenize(
  code: string,
  lang: string | undefined
): readonly (readonly Token[])[] {
  loaded();

  if (lang === undefined) {
    return plain(code);
  }

  if (hljs === undefined || !registered.has(lang)) {
    request(lang);
    return plain(code);
  }

  try {
    const html = hljs.highlight(code, {
      language: lang,
      ignoreIllegals: true,
    }).value;
    return split(parse(html));
  } catch {
    return plain(code);
  }
}

function plain(code: string): readonly (readonly Token[])[] {
  return code.split("\n").map((line) => (line === "" ? [] : [{ text: line }]));
}

/**
 * highlight.js's HTML, read back as tokens. Its output is a tree of nested
 * `<span class="hljs-…">`, and walking it is both safer and cheaper than
 * setting it as `innerHTML` in the transcript: nothing the model wrote can
 * ever be interpreted as markup, and the diff painter needs the text anyway
 * to intersect it with the intra-line emphasis ranges.
 */
function parse(html: string): readonly Token[] {
  const template = document.createElement("template");
  template.innerHTML = html;

  const tokens: Token[] = [];
  const walk = (node: Node, role: SyntaxRole | undefined): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        tokens.push({ text: child.textContent ?? "", role });
        continue;
      }
      walk(child, roleOf(child as globalThis.Element) ?? role);
    }
  };
  walk(template.content, undefined);

  return tokens;
}

/**
 * The innermost role a span names. highlight.js writes sub-scopes as a second
 * class — `hljs-title function_` — so the more specific one is preferred, and
 * a scope with no role of its own inherits the one it sits in.
 */
function roleOf(element: globalThis.Element): SyntaxRole | undefined {
  let role: SyntaxRole | undefined;

  for (const name of Array.from(element.classList)) {
    role = SCOPES[name.replace(/^hljs-/, "")] ?? role;
  }

  return role;
}

/** Tokens re-cut at every newline, so each line is its own list. */
function split(tokens: readonly Token[]): readonly (readonly Token[])[] {
  const lines: Token[][] = [[]];

  for (const token of tokens) {
    const parts = token.text.split("\n");
    for (const [index, text] of parts.entries()) {
      if (index > 0) {
        lines.push([]);
      }
      if (text !== "") {
        lines[lines.length - 1]!.push({ text, role: token.role });
      }
    }
  }

  return lines;
}

export const Highlight = {
  tokenize,
  /**
   * How many grammars have landed. A reactive read, for the one consumer that
   * cannot re-derive its output from scratch — `Markdown`, whose DOM belongs
   * to the streaming parser — and so has to be told when to repaint.
   */
  version: loaded,
};
