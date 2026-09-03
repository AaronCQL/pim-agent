import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

/** A file that now lives on the machine the agent runs on. */
export type StoredAttachment = {
  /** Names the file within its scope; what a client sends back on a prompt. */
  readonly id: string;
  /** Absolute path on the server. The only path the agent is ever told. */
  readonly path: string;
  readonly mimeType: string;
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

export type AttachmentPrompt = {
  /** One line per file, appended to the prompt text. */
  readonly lines: readonly string[];
  readonly images: NonNullable<PromptOptions["images"]>;
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
    const dir = this.scopeDir(scope);
    await mkdir(dir, { recursive: true });

    const id = safeName(
      `${input.stem ?? Bun.randomUUIDv7()}-${Date.now()}${extensionOf(input)}`
    );
    const path = contain(dir, id);
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

  private scopeDir(scope: string): string {
    return contain(this.root, safeName(scope));
  }
}

/** What the prompt says about a set of stored files, and nothing more. */
export function toAttachmentPrompt(
  files: readonly StoredAttachment[]
): AttachmentPrompt {
  const lines: string[] = [];
  const images: NonNullable<PromptOptions["images"]> = [];
  for (const file of files) {
    if (file.imageBase64) {
      images.push({
        type: "image",
        data: file.imageBase64,
        mimeType: file.mimeType,
      });
      lines.push(`[Image attachment: ${file.path}]`);
      continue;
    }
    lines.push(`[Attachment: ${file.path}]`);
  }
  return { lines, images };
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
