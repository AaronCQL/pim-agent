export type UpdateChunk = {
  readonly changeContext: string | undefined;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly isEndOfFile: boolean;
};

export type AddHunk = {
  readonly kind: "add";
  readonly path: string;
  readonly contents: string;
};

export type DeleteHunk = {
  readonly kind: "delete";
  readonly path: string;
};

export type UpdateHunk = {
  readonly kind: "update";
  readonly path: string;
  readonly movePath: string | undefined;
  readonly chunks: readonly UpdateChunk[];
};

export type Hunk = AddHunk | DeleteHunk | UpdateHunk;

export type Patch = {
  readonly hunks: readonly Hunk[];
};
