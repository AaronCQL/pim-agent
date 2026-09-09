const PREFIX = "/image/";

/** Only the names a tool writes: a hex digest and one of the formats a provider takes. */
const NAME = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;

/** Server-relative address of a picture a tool view names, the way an attachment's `url` is. */
function url(sha256: string, extension: string): string {
  return `${PREFIX}${sha256}.${extension}`;
}

/** Whether the gateway should route this path to its picture handler. */
function owns(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

/** The `<sha256>.<ext>` a request addresses, or null when it is not a name we ever served. */
function nameOf(pathname: string): string | null {
  const name = pathname.slice(PREFIX.length);
  return owns(pathname) && NAME.test(name) ? name : null;
}

/** `GET /image/<sha256>.<ext>`: the one spelling the server answers and the client asks for. */
export const ImageRoute = { url, owns, nameOf };
