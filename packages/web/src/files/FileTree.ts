import { baseName } from "../format";

export type TreeNode = {
  /** Several segments when single-child folders are folded together. */
  readonly name: string;
  readonly path: string;
  /** Absent on a file. */
  readonly children?: readonly TreeNode[];
};

export type TreeRow = {
  readonly node: TreeNode;
  readonly depth: number;
};

type Draft = {
  readonly files: Set<string>;
  readonly dirs: Map<string, Draft>;
};

/** Max rows a filter answers. */
const MATCH_LIMIT = 200;

function draft(): Draft {
  return { files: new Set(), dirs: new Map() };
}

function byName(left: TreeNode, right: TreeNode): number {
  const name = (node: TreeNode): string => node.name.toLowerCase();
  return name(left) < name(right) ? -1 : name(left) > name(right) ? 1 : 0;
}

function join(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

function seal(name: string, path: string, held: Draft): TreeNode {
  const [only] = held.dirs;
  if (name !== "" && held.files.size === 0 && held.dirs.size === 1 && only) {
    const [child, inner] = only;
    return seal(`${name}/${child}`, join(path, child), inner);
  }
  const dirs = [...held.dirs]
    .map(([child, inner]) => seal(child, join(path, child), inner))
    .toSorted(byName);
  const files = [...held.files]
    .map((file) => ({ name: file, path: join(path, file) }))
    .toSorted(byName);
  return { name, path, children: [...dirs, ...files] };
}

/** Folders first, each level by name; a folder holding one folder and nothing else folds into it. */
function build(paths: readonly string[]): TreeNode {
  const root = draft();
  for (const path of paths) {
    const segments = path.split("/");
    const file = segments.pop();
    if (file === undefined || file === "") {
      continue;
    }
    let at = root;
    for (const segment of segments) {
      let next = at.dirs.get(segment);
      if (next === undefined) {
        next = draft();
        at.dirs.set(segment, next);
      }
      at = next;
    }
    at.files.add(file);
  }
  return seal("", "", root);
}

/** The rows on screen: children of open folders only. */
function rows(
  root: TreeNode,
  isOpen: (path: string) => boolean
): readonly TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children ?? []) {
      out.push({ node: child, depth });
      if (child.children !== undefined && isOpen(child.path)) {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Every folder above `path`, shallowest first. */
function ancestors(path: string): readonly string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, at) => segments.slice(0, at + 1).join("/"));
}

/** Paths holding every word of `query`; ones whose name holds it come first. */
function match(paths: readonly string[], query: string): readonly string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const named: string[] = [];
  const nested: string[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (!words.every((word) => lower.includes(word))) {
      continue;
    }
    const name = baseName(lower);
    if (words.some((word) => name.includes(word))) {
      named.push(path);
    } else if (nested.length < MATCH_LIMIT) {
      nested.push(path);
    }
    if (named.length >= MATCH_LIMIT) {
      break;
    }
  }
  return [...named, ...nested.slice(0, MATCH_LIMIT - named.length)];
}

export const FileTree = { build, rows, ancestors, match };
