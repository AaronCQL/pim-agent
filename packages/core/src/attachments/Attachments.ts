import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import { basename, extname } from "node:path";

import type { StoredAttachment } from "./AttachmentStore";

export type AttachmentPrompt = {
  readonly lines: readonly string[];
  readonly images: NonNullable<PromptOptions["images"]>;
};

export type PromptAttachment = {
  readonly path: string;
  readonly isImage: boolean;
};

export type ParsedPrompt = {
  /** The prompt with the marker lines removed. */
  readonly text: string;
  readonly files: readonly PromptAttachment[];
};

// Old session files carry older spellings; keep matching them.
const MARKER = /^\[(image )?attachment:\s*(.+)]$/i;

const STAMP = /-\d{10,}$/;

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
  return files.length === 0
    ? { text, files }
    : { text: kept.join("\n").trim(), files };
}

function nameOf(path: string): string {
  const file = basename(path);
  const ext = extname(file);
  return `${file.slice(0, file.length - ext.length).replace(STAMP, "")}${ext}`;
}

export const Attachments = { render, parse, nameOf };
