import { basename, dirname, join } from "node:path";

import {
  AttachmentStore,
  type StoredAttachment,
} from "#core/attachments/AttachmentStore";
import { Paths } from "#core/shared/Paths";
import { IMMUTABLE, serveFile } from "./StaticClient";

export type AttachmentEndpointDeps = {
  /** Defaults to `~/.pim/attachments`. */
  readonly root?: string;
  readonly maxBytes?: number;
  /** How long an upload no prompt has taken is kept. */
  readonly ttlMs?: number;
  readonly now?: () => number;
};

type Pending = StoredAttachment & { readonly arrivedAt: number };

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const DEFAULT_TTL_MS = 60 * 60 * 1000;

const PREFIX = "/attachment/";

export function defaultAttachmentsRoot(): string {
  return join(Paths.pimHomeDir(), "attachments");
}

// Any origin: in dev the client is served from vite's port.
function allow(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-headers", "content-type");
  return response;
}

/** Uses only the last two path segments, never the server's layout. */
export function attachmentUrl(path: string): string {
  const scope = encodeURIComponent(basename(dirname(path)));
  return `${PREFIX}${scope}/${encodeURIComponent(basename(path))}`;
}

/** `POST /upload?session=<id>` with a multipart `file` field; `GET /attachment/<session>/<file>` reads it back. */
export class AttachmentEndpoint {
  private readonly store: AttachmentStore;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly bySession = new Map<string, Map<string, Pending>>();

  public constructor(deps: AttachmentEndpointDeps = {}) {
    this.store = new AttachmentStore(deps.root ?? defaultAttachmentsRoot());
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  public static owns(pathname: string): boolean {
    return pathname === "/upload" || pathname.startsWith(PREFIX);
  }

  public async handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return allow(new Response(null, { status: 204 }));
    }
    const { pathname } = new URL(request.url);
    return allow(
      pathname.startsWith(PREFIX)
        ? await this.serve(pathname)
        : await this.upload(request)
    );
  }

  // `locate` re-sanitises each segment, so a crafted name cannot escape its scope.
  private async serve(pathname: string): Promise<Response> {
    const [scope, name, ...rest] = pathname
      .slice(PREFIX.length)
      .split("/")
      .map(decodeURIComponentSafely);
    if (!scope || !name || rest.length > 0) {
      return new Response("not found", { status: 404 });
    }
    let path: string;
    try {
      path = this.store.locate(scope, name);
    } catch {
      return new Response("not found", { status: 404 });
    }
    return serveFile(path, IMMUTABLE);
  }

  private async upload(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("expected POST", { status: 405 });
    }
    const sessionId = new URL(request.url).searchParams.get("session");
    if (!sessionId) {
      return Response.json({ error: "missing ?session" }, { status: 400 });
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > this.maxBytes) {
      return this.tooLarge();
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
      return this.tooLarge();
    }

    let stored: StoredAttachment;
    try {
      stored = await this.store.store(sessionId, {
        bytes: await file.arrayBuffer(),
        mimeType: file.type || "application/octet-stream",
        name: file.name,
        stem: stemOf(file.name),
      });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
    this.remember(sessionId, stored);

    return Response.json({
      id: stored.id,
      path: stored.path,
      url: attachmentUrl(stored.path),
      mimeType: stored.mimeType,
      isImage: stored.imageBase64 !== undefined,
    });
  }

  /** Consumes the uploads a prompt referenced; unknown ids are ignored, so a replay cannot re-attach. */
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
        const { arrivedAt: _, ...attachment } = stored;
        taken.push(attachment);
      }
    }
    if (pending.size === 0) {
      this.bySession.delete(sessionId);
    }
    return taken;
  }

  private tooLarge(): Response {
    return Response.json(
      { error: `upload exceeds ${this.maxBytes} bytes` },
      { status: 413 }
    );
  }

  private remember(sessionId: string, stored: StoredAttachment): void {
    const now = this.now();
    this.sweep(now);
    const pending = this.bySession.get(sessionId) ?? new Map<string, Pending>();
    pending.set(stored.id, { ...stored, arrivedAt: now });
    this.bySession.set(sessionId, pending);
  }

  private sweep(now: number): void {
    for (const [sessionId, pending] of this.bySession) {
      for (const [id, stored] of pending) {
        if (now - stored.arrivedAt >= this.ttlMs) {
          pending.delete(id);
        }
      }
      if (pending.size === 0) {
        this.bySession.delete(sessionId);
      }
    }
  }
}

function stemOf(name: string): string | undefined {
  const stem = basename(name).replace(/\.[^.]*$/, "");
  return stem === "" ? undefined : stem;
}

function decodeURIComponentSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}
