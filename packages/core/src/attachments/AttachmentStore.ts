import { mkdir } from "node:fs/promises";
import { basename, extname } from "node:path";

import { SafePath } from "../shared/SafePath";

export type StoredFile = {
  /** Unique within its scope. */
  readonly id: string;
  /** Absolute path on the server. */
  readonly path: string;
  readonly mimeType: string;
};

export type StoredAttachment = StoredFile & {
  /** Set only for images up to IMAGE_BYTES_LIMIT. */
  readonly imageBase64: string | undefined;
};

export type AttachmentInput = {
  readonly bytes: ArrayBuffer;
  readonly mimeType: string;
  /** Client-supplied filename; only its extension is used. */
  readonly name?: string;
  /** Defaults to a random UUID. */
  readonly stem?: string;
  /** Used when `name` has no extension. */
  readonly ext?: string;
};

const IMAGE_BYTES_LIMIT = 4 * 1024 * 1024;

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

  public async storeFile(scope: string, source: string): Promise<StoredFile> {
    const file = Bun.file(source);
    const name = basename(source);
    const ext = extname(name);
    // `basename(name, ext)` keeps dotfiles like `.bashrc` named.
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
    const id = SafePath.safeName(
      `${stem || Bun.randomUUIDv7()}-${Date.now()}${ext}`
    );
    return { id, path: SafePath.contain(dir, id) };
  }

  private scopeDir(scope: string): string {
    return SafePath.contain(this.root, SafePath.safeName(scope));
  }

  /** The id is re-sanitised, so it cannot escape its scope. */
  public locate(scope: string, id: string): string {
    return SafePath.contain(this.scopeDir(scope), SafePath.safeName(id));
  }
}

function extensionOf(input: AttachmentInput): string {
  const fromName = extname(basename(input.name ?? ""));
  return fromName || input.ext || "";
}
