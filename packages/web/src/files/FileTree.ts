import type { FolderEntry, FolderListing } from "#protocol/Diff";
import { baseName } from "../format";

export type Loaded<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: T }
  | { readonly kind: "error"; readonly message: string };

export type Folder = Loaded<FolderListing>;

export type TreeRow =
  | {
      readonly kind: "entry";
      readonly entry: FolderEntry;
      readonly depth: number;
      /** Set on a filter hit, which shows its whole path. */
      readonly lead?: string;
    }
  | {
      readonly kind: "note";
      readonly folder: string;
      readonly depth: number;
      readonly text: string;
      readonly failed: boolean;
    };

/** The rows on screen: the root's entries, and those of every open folder listed so far. */
function rows(
  folders: Readonly<Record<string, Folder>>,
  isOpen: (path: string) => boolean
): readonly TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (path: string, depth: number): void => {
    const folder = folders[path];
    if (folder?.kind === "error") {
      out.push({
        kind: "note",
        folder: path,
        depth,
        text: folder.message,
        failed: true,
      });
    }
    if (folder?.kind !== "ready") {
      return;
    }
    for (const entry of folder.value.entries) {
      out.push({ kind: "entry", entry, depth });
      if (entry.kind === "folder" && isOpen(entry.path)) {
        walk(entry.path, depth + 1);
      }
    }
    if (folder.value.truncated === true) {
      out.push({
        kind: "note",
        folder: path,
        depth,
        text: "Some files not shown",
        failed: false,
      });
    }
  };
  walk("", 0);
  return out;
}

/** The filter's hits as flat rows, each led by the folders above it. */
function hits(paths: readonly string[]): readonly TreeRow[] {
  return paths.map((path) => {
    const name = baseName(path);
    return {
      kind: "entry",
      entry: { name, path, kind: "file" },
      depth: 0,
      lead: path.slice(0, path.length - name.length),
    };
  });
}

/** Every folder above `path`, shallowest first. */
function ancestors(path: string): readonly string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, at) => segments.slice(0, at + 1).join("/"));
}

export const FileTree = { rows, hits, ancestors };
