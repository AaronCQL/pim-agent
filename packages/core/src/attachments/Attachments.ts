import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import { basename, extname } from "node:path";

import type { StoredAttachment } from "./AttachmentStore";

export type AttachmentPrompt = {
  /** One line per file, appended to the prompt text. */
  readonly lines: readonly string[];
  readonly images: NonNullable<PromptOptions["images"]>;
};

/** One file a prompt carried, read back out of the text that carried it. */
export type PromptAttachment = {
  readonly path: string;
  readonly isImage: boolean;
};

export type ParsedPrompt = {
  /** The prompt with the marker lines removed: what a person actually said. */
  readonly text: string;
  readonly files: readonly PromptAttachment[];
};

/**
 * Both spellings `render` has ever produced, case-insensitively: a session
 * file is history, and a marker written by an older pim is still the only
 * record that message had a file on it.
 */
const MARKER = /^\[(image )?attachment:\s*(.+)]$/i;

/** The uniquifying stamp `AttachmentStore` appends to every stored name. */
const STAMP = /-\d{10,}$/;

/**
 * What the prompt says about a set of stored files, and nothing more. The
 * agent is told a server path; the bytes of an image small enough to inline
 * travel beside the text as content rather than in it.
 */
function render(files: readonly StoredAttachment[]): AttachmentPrompt {
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

/**
 * Undoes `render` over a message read back from the log.
 *
 * The marker is how the *model* is told where a file lives: pi's image
 * content is bytes and a mime type and carries no path, and a file with no
 * bytes beside it — anything not an image, or an image too large to inline —
 * is the marker and nothing else. A reader was never the audience for either,
 * so anything drawing that message takes the files out of the text and paints
 * them as files.
 */
function parse(text: string): ParsedPrompt {
  const kept: string[] = [];
  const files: PromptAttachment[] = [];
  for (const line of text.split("\n")) {
    const marker = MARKER.exec(line.trim());
    if (marker) {
      files.push({ path: marker[2]!, isImage: marker[1] !== undefined });
      continue;
    }
    kept.push(line);
  }
  // Untouched when there was nothing to take out, so an ordinary message is
  // the same string it arrived as and not a trimmed copy of one.
  return files.length === 0
    ? { text, files }
    : { text: kept.join("\n").trim(), files };
}

/**
 * What to call a stored file on screen. `AttachmentStore` stamps every name
 * it writes so two uploads of `shot.png` cannot collide; the stamp is storage
 * bookkeeping and means nothing to the person who uploaded it.
 */
function nameOf(path: string): string {
  const file = basename(path);
  const ext = extname(file);
  return `${file.slice(0, file.length - ext.length).replace(STAMP, "")}${ext}`;
}

export const Attachments = { render, parse, nameOf };
