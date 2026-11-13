import { Languages } from "#core/shared/Languages";

const CODE = "i-griddy-icons:file-code";
const TEXT = "i-griddy-icons:file-text";
const CONFIG = "i-griddy-icons:settings";
const LOCK = "i-griddy-icons:lock";
const SHELL = "i-griddy-icons:terminal";
const IMAGE = "i-griddy-icons:image";
const GIT = "i-griddy-icons:code-branch";
const SECRET = "i-griddy-icons:key";
const DOCKER = "i-griddy-icons:package";
const DATA = "i-griddy-icons:database";
const TABLE = "i-griddy-icons:csv-file";
const ARCHIVE = "i-griddy-icons:archive";
const FILE = "i-griddy-icons:file";

const BY_NAME: Readonly<Record<string, string>> = {
  "bun.lockb": LOCK,
  "package-lock.json": LOCK,
  "pnpm-lock.yaml": LOCK,
  Dockerfile: DOCKER,
  "compose.yaml": DOCKER,
  "compose.yml": DOCKER,
  "docker-compose.yml": DOCKER,
  "docker-compose.yaml": DOCKER,
  ".dockerignore": DOCKER,
  ".gitignore": GIT,
  ".gitattributes": GIT,
  ".gitmodules": GIT,
  Makefile: SHELL,
  LICENSE: TEXT,
};

const BY_EXTENSION: Readonly<Record<string, string>> = {
  zig: CODE,
  md: TEXT,
  mdx: TEXT,
  txt: TEXT,
  rst: TEXT,
  json: CONFIG,
  jsonc: CONFIG,
  json5: CONFIG,
  toml: CONFIG,
  yaml: CONFIG,
  yml: CONFIG,
  ini: CONFIG,
  xml: CONFIG,
  lock: LOCK,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: SHELL,
  ps1: SHELL,
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  svg: IMAGE,
  ico: IMAGE,
  avif: IMAGE,
  sql: DATA,
  sqlite: DATA,
  db: DATA,
  csv: TABLE,
  tsv: TABLE,
  zip: ARCHIVE,
  tar: ARCHIVE,
  gz: ARCHIVE,
  tgz: ARCHIVE,
  xz: ARCHIVE,
  "7z": ARCHIVE,
};

function file(name: string): string {
  const exact = BY_NAME[name];
  if (exact !== undefined) {
    return exact;
  }
  if (name.startsWith(".env")) {
    return SECRET;
  }
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return (
    BY_EXTENSION[extension] ??
    (/^\..*rc$/.test(name)
      ? CONFIG
      : Languages.fromPath(name) === undefined
        ? FILE
        : CODE)
  );
}

function folder(open: boolean): string {
  return open
    ? "i-griddy-icons:folder-open-filled"
    : "i-griddy-icons:folder-filled";
}

export const FileIcon = { file, folder };
