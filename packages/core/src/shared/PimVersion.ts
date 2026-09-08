import ky from "ky";

import { Fs } from "./Fs";

const REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 5_000;

type Manifest = {
  readonly name: string;
  readonly version: string;
};

type LatestOptions = {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
};

async function read(url: URL): Promise<Manifest> {
  const pkg = await Fs.readJsonOr<Partial<Manifest> | null>(url, null);
  return {
    name: typeof pkg?.name === "string" ? pkg.name : "?",
    version: typeof pkg?.version === "string" ? pkg.version : "?",
  };
}

function self(): Promise<Manifest> {
  return read(new URL("../../../../package.json", import.meta.url));
}

async function current(): Promise<string> {
  return (await self()).version;
}

/** The npm package this pim was published as, and so the one to reinstall. */
async function name(): Promise<string> {
  return (await self()).name;
}

/** Pi ships inside pim's install tree, so this is the pi a user actually runs. */
async function pi(): Promise<string> {
  return (
    await read(
      new URL(
        import.meta.resolve("@earendil-works/pi-coding-agent/package.json")
      )
    )
  ).version;
}

async function latest(
  options: LatestOptions = {}
): Promise<string | undefined> {
  const pkg = await self();
  const client = options.fetch ? ky.create({ fetch: options.fetch }) : ky;
  try {
    const release = await client(
      `${REGISTRY}/${pkg.name.replace("/", "%2f")}/latest`,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retry: 0,
        headers: { accept: "application/json" },
      }
    ).json<{ readonly version?: unknown }>();
    return typeof release.version === "string" && release.version.trim()
      ? release.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function core(version: string): readonly number[] | undefined {
  const parts = version.trim().split(/[-+]/)[0]!.split(".");
  const numbers = parts.map(Number);
  return parts.length === 3 &&
    numbers.every((part) => Number.isInteger(part) && part >= 0)
    ? numbers
    : undefined;
}

function isNewer(candidate: string, installed: string): boolean {
  const left = core(candidate);
  const right = core(installed);
  if (!left || !right) {
    return candidate.trim() !== installed.trim();
  }
  for (const [index, part] of left.entries()) {
    if (part !== right[index]) {
      return part > right[index]!;
    }
  }
  // Same core: the only step forward left is a prerelease reaching its release.
  return installed.includes("-") && !candidate.includes("-");
}

export const PimVersion = { current, name, pi, latest, isNewer };
