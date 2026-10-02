const PREFIX = "/image/";

const NAME = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;

function url(sha256: string, extension: string): string {
  return `${PREFIX}${sha256}.${extension}`;
}

function owns(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

/** The `<sha256>.<ext>` a path addresses, or null when it is not a valid image name. */
function nameOf(pathname: string): string | null {
  const name = pathname.slice(PREFIX.length);
  return owns(pathname) && NAME.test(name) ? name : null;
}

/** `GET /image/<sha256>.<ext>`. */
export const ImageRoute = { url, owns, nameOf };
