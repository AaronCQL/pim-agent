import { mkdir } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

/** A file the store has taken a copy of, under a name it chose. */
export type StoredFile = {
  /** Names the file within its scope; what a client sends back on a prompt. */
  readonly id: string;
  /** Absolute path on the server. The only path the agent is ever told. */
  readonly path: string;
  readonly mimeType: string;
};

/** A file that now lives on the machine the agent runs on. */
export type StoredAttachment = StoredFile & {
  /** Present only for images small enough to inline into the prompt. */
  readonly imageBase64: string | undefined;
};

export type AttachmentInput = {
  readonly bytes: ArrayBuffer;
  readonly mimeType: string;
  /** Client-supplied filename. Only its basename is ever used. */
  readonly name?: string;
  /** Stem of the stored filename; a random one when omitted. */
  readonly stem?: string;
  /** Extension to fall back on when `name` carries none. */
  readonly ext?: string;
};

/** Above this, an image is referenced by path instead of inlined. */
const IMAGE_BYTES_LIMIT = 4 * 1024 * 1024;

/** Materialises client bytes onto the server's filesystem; the agent is only ever told a server path. */
export class AttachmentStore {
  public constructor(private readonly root: string) {}

  public async store(
    scope: string,
    input: AttachmentInput
  ): Promise<StoredAttachment> {
    const { id, path } = await this.place(
      scope,
      input.stem,
      extensionOf(input)
    );
    await Bun.write(path, input.bytes);

    const isImage = input.mimeType.startsWith("image/");
    return {
      id,
      path,
      mimeType: input.mimeType,
      imageBase64:
        isImage && input.bytes.byteLength <= IMAGE_BYTES_LIMIT
          ? Buffer.from(input.bytes).toString("base64")
          : undefined,
    };
  }

  /** Copies a file already on the agent's disk into the store so it can be served. */
  public async storeFile(scope: string, source: string): Promise<StoredFile> {
    const file = Bun.file(source);
    const name = basename(source);
    const ext = extname(name);
    // Keep `basename(name, ext)`: a regex strip leaves a dotfile like `.bashrc` with no name.
    const { id, path } = await this.place(scope, basename(name, ext), ext);
    await Bun.write(path, file);
    return { id, path, mimeType: file.type || "application/octet-stream" };
  }

  private async place(
    scope: string,
    stem: string | undefined,
    ext: string
  ): Promise<{ readonly id: string; readonly path: string }> {
    const dir = this.scopeDir(scope);
    await mkdir(dir, { recursive: true });
    const id = safeName(`${stem || Bun.randomUUIDv7()}-${Date.now()}${ext}`);
    return { id, path: contain(dir, id) };
  }

  private scopeDir(scope: string): string {
    return contain(this.root, safeName(scope));
  }

  /** Where `store` put this id; the id is re-sanitised, so it can never name a file outside its scope. */
  public locate(scope: string, id: string): string {
    return contain(this.scopeDir(scope), safeName(id));
  }
}

function extensionOf(input: AttachmentInput): string {
  const fromName = extname(basename(input.name ?? ""));
  return fromName || input.ext || "";
}

function safeName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function contain(parent: string, child: string): string {
  const path = resolve(parent, child);
  if (!path.startsWith(`${resolve(parent)}${sep}`)) {
    throw new Error(`refusing attachment path outside ${parent}: ${child}`);
  }
  return path;
}
