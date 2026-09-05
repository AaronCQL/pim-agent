import { join } from "node:path";

import {
  AttachmentStore,
  type StoredAttachment,
} from "#core/attachments/AttachmentStore";
import { Paths } from "#core/shared/Paths";

export type UploadEndpointDeps = {
  /** Defaults to `~/.pim/attachments`. */
  readonly root?: string;
  readonly maxBytes?: number;
};

/** Big enough for a phone photo or a log dump, small enough to refuse a disk. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * `POST /upload?session=<id>` with a `multipart/form-data` `file` field.
 *
 * The bytes land in the server's world and the client is answered with the
 * server path they landed at. What it uploaded them *from* is never recorded
 * anywhere: the client's own filename survives only as an extension hint, and
 * the prompt the agent eventually sees carries `path` and nothing else.
 */
export class UploadEndpoint {
  private readonly store: AttachmentStore;
  private readonly maxBytes: number;
  private readonly bySession = new Map<string, Map<string, StoredAttachment>>();

  public constructor(deps: UploadEndpointDeps = {}) {
    this.store = new AttachmentStore(
      deps.root ?? join(Paths.pimHomeDir(), "attachments")
    );
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  public async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("expected POST", { status: 405 });
    }
    const sessionId = new URL(request.url).searchParams.get("session");
    if (!sessionId) {
      return Response.json({ error: "missing ?session" }, { status: 400 });
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > this.maxBytes) {
      return Response.json(
        { error: `upload exceeds ${this.maxBytes} bytes` },
        { status: 413 }
      );
    }

    let file: File | undefined;
    try {
      const form = await request.formData();
      const field = form.get("file");
      file = field instanceof File ? field : undefined;
    } catch {
      return Response.json(
        { error: "expected multipart/form-data" },
        { status: 400 }
      );
    }
    if (!file) {
      return Response.json({ error: "missing `file` field" }, { status: 400 });
    }
    if (file.size > this.maxBytes) {
      return Response.json(
        { error: `upload exceeds ${this.maxBytes} bytes` },
        { status: 413 }
      );
    }

    let stored: StoredAttachment;
    try {
      stored = await this.store.store(sessionId, {
        bytes: await file.arrayBuffer(),
        mimeType: file.type || "application/octet-stream",
        name: file.name,
      });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
    this.remember(sessionId, stored);

    return Response.json({
      id: stored.id,
      path: stored.path,
      mimeType: stored.mimeType,
      isImage: stored.imageBase64 !== undefined,
    });
  }

  /**
   * Consume the uploads a prompt referenced. Consuming rather than reading
   * keeps the inlined image bytes from outliving the one message that needed
   * them; unknown ids are dropped, so a replayed command cannot re-attach.
   */
  public take(
    sessionId: string,
    ids: readonly string[]
  ): readonly StoredAttachment[] {
    const pending = this.bySession.get(sessionId);
    if (!pending) {
      return [];
    }
    const taken: StoredAttachment[] = [];
    for (const id of ids) {
      const stored = pending.get(id);
      if (stored) {
        pending.delete(id);
        taken.push(stored);
      }
    }
    if (pending.size === 0) {
      this.bySession.delete(sessionId);
    }
    return taken;
  }

  private remember(sessionId: string, stored: StoredAttachment): void {
    const pending = this.bySession.get(sessionId) ?? new Map();
    pending.set(stored.id, stored);
    this.bySession.set(sessionId, pending);
  }
}
