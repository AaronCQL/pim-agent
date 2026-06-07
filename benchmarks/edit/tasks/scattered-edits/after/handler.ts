import { readFile, writeFile } from "fs";

const MAX_RETRIES = 5;

export function handle(req: Request): Response {
  const body = parse(req);
  if (!body) {
    return error(422);
  }
  return ok(body);
}

function parse(req: Request): Body | null {
  return req.json();
}
