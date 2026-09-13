import { join, resolve, sep } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

import type { BunFile } from "bun";

/** The built Vite bundle, resolved relative to this file so it works installed. */
export const DEFAULT_CLIENT_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "web",
  "dist",
  "client"
);

const BUILD_HINT =
  "The pim web client has not been built.\n\n" +
  "Run `bun run web:build` in the pim checkout, then restart `pim --mode web`.\n" +
  "(Installed copies ship the bundle; a git checkout has to build it once.)\n";

/** Vite fingerprints everything under `assets/`, so it can never go stale. */
export const IMMUTABLE = "public, max-age=31536000, immutable";

const COMPRESSIBLE =
  /^(?:text\/|image\/svg\+xml|application\/(?:javascript|json|wasm|xml))/;

/** Below this a deflate stream is its own header: the framing costs more than the saving. */
const MIN_COMPRESSED = 1024;

type Bytes = Uint8Array<ArrayBuffer>;

type Encoding = {
  readonly name: string;
  readonly compress: (bytes: Bytes) => Bytes;
};

/** Best first. Brotli at q5 beats gzip -9 on both size and time; q11 would cost 40x the CPU for 8%. */
const ENCODINGS: readonly Encoding[] = [
  {
    name: "br",
    compress: (bytes) =>
      new Uint8Array(
        brotliCompressSync(bytes, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
        })
      ),
  },
  { name: "gzip", compress: (bytes) => Bun.gzipSync(bytes) },
];

type Encoded = { readonly stamp: string; readonly bytes: Bytes };

function accepts(header: string, name: string): boolean {
  return header.split(",").some((entry) => {
    const [token, ...params] = entry.trim().split(";");
    return (
      token?.toLowerCase() === name &&
      !params.some((param) => param.replaceAll(" ", "") === "q=0")
    );
  });
}

/** A file off disk under a caching policy, or the 404 that a path naming nothing is. */
export async function serveFile(
  path: string,
  cacheControl: string
): Promise<Response> {
  const file = Bun.file(path);
  return (await file.exists())
    ? new Response(file, { headers: { "cache-control": cacheControl } })
    : new Response("not found", { status: 404 });
}

function looksLikeAsset(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[a-zA-Z0-9]+$/.test(last);
}

/** Serves the built browser client as a static SPA; unknown routes fall back to `index.html`. */
export class StaticClient {
  private readonly root: string;
  private readonly encoded = new Map<string, Encoded>();

  public constructor(root: string = DEFAULT_CLIENT_DIR) {
    this.root = resolve(root);
  }

  public async handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const path = this.within(pathname);
    if (path !== undefined) {
      const file = Bun.file(path);
      if (await file.exists()) {
        return await this.respond(
          file,
          request,
          pathname.startsWith("/assets/") ? IMMUTABLE : "no-cache"
        );
      }
    }
    if (looksLikeAsset(pathname)) {
      return new Response("not found", { status: 404 });
    }
    const index = Bun.file(join(this.root, "index.html"));
    if (!(await index.exists())) {
      return new Response(BUILD_HINT, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return await this.respond(
      index,
      request,
      "no-cache",
      "text/html; charset=utf-8"
    );
  }

  // `vary` rides every answer, compressed or not: a cache must not hand one client's encoding to another.
  private async respond(
    file: BunFile,
    request: Request,
    cacheControl: string,
    contentType = file.type
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": contentType,
      "cache-control": cacheControl,
      vary: "accept-encoding",
    };
    const encoding = this.negotiate(file, request);
    if (encoding === undefined) {
      return new Response(file, { headers });
    }
    return new Response(await this.compress(file, encoding), {
      headers: { ...headers, "content-encoding": encoding.name },
    });
  }

  private negotiate(file: BunFile, request: Request): Encoding | undefined {
    if (!COMPRESSIBLE.test(file.type) || file.size < MIN_COMPRESSED) {
      return undefined;
    }
    const accepted = request.headers.get("accept-encoding") ?? "";
    return ENCODINGS.find((encoding) => accepts(accepted, encoding.name));
  }

  // Keyed by name, stamped by mtime: a rebuilt bundle replaces its entry instead of adding one.
  private async compress(file: BunFile, encoding: Encoding): Promise<Bytes> {
    const key = `${file.name ?? ""}\0${encoding.name}`;
    const stamp = `${file.lastModified}:${file.size}`;
    const cached = this.encoded.get(key);
    if (cached?.stamp === stamp) {
      return cached.bytes;
    }
    const bytes = encoding.compress(await file.bytes());
    this.encoded.set(key, { stamp, bytes });
    return bytes;
  }

  // `new URL()` normalises literal `../` but not its percent-encoded spelling: re-resolve the decoded path.
  private within(pathname: string): string | undefined {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0")) {
      return undefined;
    }
    const candidate = resolve(join(this.root, decoded));
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      return undefined;
    }
    return candidate === this.root ? undefined : candidate;
  }
}
