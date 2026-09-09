import { join, resolve, sep } from "node:path";

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

function looksLikeAsset(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[a-zA-Z0-9]+$/.test(last);
}

/** Serves the built browser client as a static SPA; unknown routes fall back to `index.html`. */
export class StaticClient {
  private readonly root: string;

  public constructor(root: string = DEFAULT_CLIENT_DIR) {
    this.root = resolve(root);
  }

  public async handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const path = this.within(pathname);
    if (path !== undefined) {
      const file = Bun.file(path);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "cache-control": pathname.startsWith("/assets/")
              ? IMMUTABLE
              : "no-cache",
          },
        });
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
    return new Response(index, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
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
