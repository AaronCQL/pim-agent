import { createSignal } from "solid-js";

import type hljsCore from "highlight.js/lib/core";

/** Same folding of highlight.js scopes as the TUI. */
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
  | "punctuation"
  | "added"
  | "removed";

export type Token = {
  readonly text: string;
  readonly role?: SyntaxRole;
};

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
  addition: "added",
  deletion: "removed",
};

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
  // No fish grammar ships with highlight.js; bash is close enough.
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

// Bumped when a grammar loads, so `tokenize` callers re-run.
const [loaded, setLoaded] = createSignal(0);

const registered = new Set<string>();
const pending = new Set<string>();

type Grammar = { readonly default: unknown };

let hljs: typeof hljsCore | undefined;

/** Larger blocks stay plain: highlighting them freezes the tab. */
const TEXT_LIMIT = 100_000;

const LINE_LIMIT = 2000;

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
  // highlight.js language modules default-export the definition function.
  core.registerLanguage(lang, (module as Grammar).default as never);
  registered.add(lang);
  setLoaded((version) => version + 1);
}

function request(lang: string): void {
  if (pending.has(lang)) {
    return;
  }

  pending.add(lang);
  void load(lang).catch(() => {});
}

/** One token list per line. Pass whole blocks: multi-line comments and strings need both ends. */
function tokenize(
  code: string,
  lang: string | undefined
): readonly (readonly Token[])[] {
  loaded();

  if (lang === undefined || oversized(code)) {
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

function oversized(code: string): boolean {
  return code.length > TEXT_LIMIT || code.split("\n").length > LINE_LIMIT;
}

function plain(code: string): readonly (readonly Token[])[] {
  return code.split("\n").map((line) => (line === "" ? [] : [{ text: line }]));
}

// Walked into tokens, never injected as HTML.
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

// highlight.js writes sub-scopes as a second class, so the last one wins.
function roleOf(element: globalThis.Element): SyntaxRole | undefined {
  let role: SyntaxRole | undefined;

  for (const name of Array.from(element.classList)) {
    role = SCOPES[name.replace(/^hljs-/, "")] ?? role;
  }

  return role;
}

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
  /** Reactive count of loaded grammars. */
  version: loaded,
};
