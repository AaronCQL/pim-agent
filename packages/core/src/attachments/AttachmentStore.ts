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

/**
 * Materialises client bytes into the server's filesystem, which is the only
 * filesystem the agent has.
 *
 * This is the whole reason an upload is not a picker: a client names a file in
 * a world the agent cannot see, so the bytes must be transferred before the
 * agent can be told anything at all — and what it is told is a *server* path,
 * never the client's. Telegram's `getFile` and the web's `POST /upload` are
 * two adapters over this one flow.
 */
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

  /**
   * The other direction: a file already on the agent's disk, copied in so it
   * can be *served*. The copy is the point — the store's names are stamped
   * and immutable, and the endpoint answers for them without ever being told
   * a path, so a delivered file cannot change or vanish under the transcript
   * that references it, and nothing outside this root is ever reachable.
   *
   * No `imageBase64`: that exists to inline an inbound image into a prompt,
   * and the agent is the sender here.
   */
  public async storeFile(scope: string, source: string): Promise<StoredFile> {
    const file = Bun.file(source);
    const name = basename(source);
    const ext = extname(name);
    // `basename(name, ext)` rather than a regex, so a dotfile keeps the only
    // name it has: `extname(".bashrc")` is empty, and stripping a trailing
    // dotted run would leave nothing to call it.
    const { id, path } = await this.place(scope, basename(name, ext), ext);
    // `Bun.write` streams a `BunFile` source rather than buffering it.
    await Bun.write(path, file);
    return { id, path, mimeType: file.type || "application/octet-stream" };
  }

  /** The name this store would give a file, and the directory it goes in. */
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

  /**
   * Where `store` put — or would have put — this id. The reverse of an
   * upload, and the only way back to the bytes: an id off the wire is
   * sanitised exactly as it was on the way in, so a crafted one can name a
   * file that does not exist but never one outside its scope.
   */
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

/**
 * `safeName` already strips separators, so this can only fire on a name that
 * is pure dots. Cheap, and the failure it guards against is arbitrary write.
 */
function contain(parent: string, child: string): string {
  const path = resolve(parent, child);
  if (!path.startsWith(`${resolve(parent)}${sep}`)) {
    throw new Error(`refusing attachment path outside ${parent}: ${child}`);
  }
  return path;
}
