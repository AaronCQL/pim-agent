import { join } from "node:path";

import { Images } from "#core/shared/Images";
import { SpillCache } from "#core/shared/SpillCache";
import { ImageRoute } from "#protocol/ImageRoute";
import { IMMUTABLE, serveFile } from "./StaticClient";

export type ImageEndpointDeps = {
  /** Defaults to `~/.pim/cache`. */
  readonly root?: string;
};

/** Serves images cached by `read`; 404 once the TTL sweep removed them. */
export class ImageEndpoint {
  private readonly root: string;

  public constructor(deps: ImageEndpointDeps = {}) {
    this.root = deps.root ?? SpillCache.dir();
  }

  public static owns(pathname: string): boolean {
    return ImageRoute.owns(pathname);
  }

  public async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("expected GET", { status: 405 });
    }
    // `nameOf` only admits `<hex>.<ext>`, so no path traversal.
    const name = ImageRoute.nameOf(new URL(request.url).pathname);
    return name === null
      ? new Response("not found", { status: 404 })
      : serveFile(join(this.root, `${Images.CACHE_PREFIX}${name}`), IMMUTABLE);
  }
}
