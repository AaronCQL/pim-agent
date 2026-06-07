import { readFile } from "fs";

const MAX_RETRIES = 3;

export function handle(req: Request): Response {
  const body = parse(req);
  if (!body) {
    return error(400);
  }
  return ok(body);
}

function parse(req: Request): Body | null {
  return req.json();
}
