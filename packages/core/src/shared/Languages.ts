/**
 * What language a file is written in, by name or by extension.
 *
 * pi ships `getLanguageFromPath`, but it lives behind the agent's node-only
 * entry point, so a browser bundle cannot have it — and a second table copied
 * into the web client would be a table free to drift, with the TUI and the web
 * quietly highlighting the same `.tsx` two different ways. So the table is
 * owned here, in a module with no imports, and both surfaces read it.
 *
 * The values are highlight.js language ids, which is what both surfaces
 * ultimately highlight with: the TUI through pi's `highlightCode`, the web
 * through its own lazily loaded grammars.
 */

const ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  lua: "lua",
  perl: "perl",
  pl: "perl",
  r: "r",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  vim: "vim",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  tf: "hcl",
  hcl: "hcl",
  diff: "diff",
  patch: "diff",
};

/** Every id the table can produce, so a canonical name resolves to itself. */
const CANONICAL: ReadonlySet<string> = new Set(Object.values(ALIASES));

/**
 * The language behind a name, extension or alias — `tsx`, `typescript` and
 * `TS` all being the same language — or undefined when it is not one we know.
 * Never guessed: pi's note holds here too, that auto-detection reads prose as
 * AppleScript and colours ordinary English as keywords.
 */
function resolve(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }

  const key = name.trim().toLowerCase();
  return CANONICAL.has(key) ? key : ALIASES[key];
}

/**
 * The language a path is in. Extensionless names are looked up whole, so a
 * bare `Dockerfile` or `Makefile` is recognised by its own name.
 */
function fromPath(path: string): string | undefined {
  const base = path.split(/[/\\]/).pop() ?? "";
  return resolve(base.includes(".") ? base.split(".").pop() : base);
}

export const Languages = { resolve, fromPath };
