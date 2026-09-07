import { basename, dirname, join } from "node:path";

import {
  AttachmentStore,
  type StoredAttachment,
} from "#core/attachments/AttachmentStore";
import { Paths } from "#core/shared/Paths";

export type AttachmentEndpointDeps = {
  /** Defaults to `~/.pim/attachments`. */
  readonly root?: string;
  readonly maxBytes?: number;
};

/** Big enough for a phone photo or a log dump, small enough to refuse a disk. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** A stored name carries a stamp, so the bytes under it can never change. */
const IMMUTABLE = "public, max-age=31536000, immutable";

const PREFIX = "/attachment/";

/**
 * A WebSocket is exempt from the same-origin policy; this endpoint is not, and
 * in development the client is served by vite on its own port — so its upload
 * is a cross-origin request and dies in the browser before it is ever sent.
 * Allowing every origin gives away nothing the socket does not already give
 * away, since any page can open one against this port without asking.
 */
function allow(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-headers", "content-type");
  return response;
}

/**
 * Where `serve` answers for a stored file, as a client asks for it: the last
 * two segments of the path and nothing else, so the server's own layout stays
 * on the server. A file stored under some other root — Telegram keeps its own
 * — resolves to a URL this server has no bytes for, and the client draws the
 * name instead of a picture it cannot fetch.
 */
export function attachmentUrl(path: string): string {
  const scope = encodeURIComponent(basename(dirname(path)));
  return `${PREFIX}${scope}/${encodeURIComponent(basename(path))}`;
}

/**
 * The two directions bytes travel between a browser and the agent's disk:
 * `POST /upload?session=<id>` with a `multipart/form-data` `file` field, and
 * `GET /attachment/<session>/<file>` to see one again.
 *
 * The upload is the whole reason an attachment is not a picker: a client names
 * a file in a world the agent cannot see, so the bytes must be transferred
 * before the agent can be told anything at all — and what it is told is a
 * *server* path, never the client's, which is never recorded anywhere.
 *
 * The read direction exists because the prompt is not a gallery. What the
 * agent is told is a path, and a path is the last thing a person wants to
 * look at: the client fetches the bytes and paints the picture, over HTTP
 * rather than over the socket, so the browser's own cache answers the second
 * look at a conversation and a replay never carries an image twice.
 */
export class AttachmentEndpoint {
  private readonly store: AttachmentStore;
  private readonly maxBytes: number;
  private readonly bySession = new Map<string, Map<string, StoredAttachment>>();

  public constructor(deps: AttachmentEndpointDeps = {}) {
    this.store = new AttachmentStore(
      deps.root ?? join(Paths.pimHomeDir(), "attachments")
    );
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** Whether this endpoint owns the path, so the gateway can route to it. */
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

  /**
   * Hands back bytes this server stored. Every segment goes back through the
   * sanitising the write did, so a crafted name can only ever miss: nothing
   * outside the scope it names is reachable, and a scope is a session.
   */
  private async serve(pathname: string): Promise<Response> {
    const [scope, name, ...rest] = pathname
      .slice(PREFIX.length)
      .split("/")
      .map(decodeURIComponentSafely);
    if (!scope || !name || rest.length > 0) {
      return new Response("not found", { status: 404 });
    }
    let file;
    try {
      file = Bun.file(this.store.locate(scope, name));
    } catch {
      return new Response("not found", { status: 404 });
    }
    if (!(await file.exists())) {
      return new Response("not found", { status: 404 });
    }
    return new Response(file, { headers: { "cache-control": IMMUTABLE } });
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
        // The client's own name for the bytes, so what a reader is shown a
        // week later is `diagram.png` and not a UUID. It is a *hint*: the
        // store sanitises and stamps it, and the result is the only name
        // anything on this side ever uses.
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

function stemOf(name: string): string | undefined {
  const stem = basename(name).replace(/\.[^.]*$/, "");
  return stem === "" ? undefined : stem;
}

/** A name that is not valid percent-encoding is a name nothing stored. */
function decodeURIComponentSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}
