import { join } from "node:path";

import { Images } from "#core/shared/Images";
import { SpillCache } from "#core/shared/SpillCache";
import { ImageRoute } from "#protocol/ImageRoute";
import { IMMUTABLE, serveFile } from "./StaticClient";

export type ImageEndpointDeps = {
  /** Defaults to `~/.pim/cache`, where `read` spills the picture it showed the model. */
  readonly root?: string;
};

/** `GET /image/<sha256>.<ext>`: the cached copy of a picture a tool view addresses, or 404 once the TTL sweep took it. */
export class ImageEndpoint {
  private readonly root: string;

  public constructor(deps: ImageEndpointDeps = {}) {
    this.root = deps.root ?? SpillCache.dir();
  }

  /** Whether this endpoint owns the path, so the gateway can route to it. */
  public static owns(pathname: string): boolean {
    return ImageRoute.owns(pathname);
  }

  public async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("expected GET", { status: 405 });
    }
    // The name is a digest and a format we wrote, which admits no separator to escape the cache with.
    const name = ImageRoute.nameOf(new URL(request.url).pathname);
    return name === null
      ? new Response("not found", { status: 404 })
      : serveFile(join(this.root, `${Images.CACHE_PREFIX}${name}`), IMMUTABLE);
  }
}
