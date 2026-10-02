// Values are highlight.js language ids. Keep import-free: the web bundle uses it.

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

const CANONICAL: ReadonlySet<string> = new Set(Object.values(ALIASES));

// Unknown names stay undefined: auto-detection paints prose as code.
function resolve(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }

  const key = name.trim().toLowerCase();
  return CANONICAL.has(key) ? key : ALIASES[key];
}

function fromPath(path: string): string | undefined {
  const base = path.split(/[/\\]/).pop() ?? "";
  return resolve(base.includes(".") ? base.split(".").pop() : base);
}

export const Languages = { resolve, fromPath };
