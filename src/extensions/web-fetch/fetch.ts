import { isIP } from "node:net";
import { Lines } from "../../shared/Lines";
import { OutputBudget } from "../../shared/OutputBudget";
import { SpillCache } from "../../shared/SpillCache";
import type { JinaReaderClient } from "./JinaReaderClient";
import {
  WEB_FETCH_INLINE_BYTES,
  type WebFetchFormat,
  type WebFetchResolvedFormat,
} from "./schema";
import type { WebViewFetchClient } from "./WebViewFetchClient";

export type WebFetchPage = {
  readonly title: string;
  readonly url: string;
  readonly content: string;
};

export type WebFetchOutcome = {
  readonly text: string;
  readonly title: string;
  readonly url: string;
  readonly format: WebFetchResolvedFormat;
  readonly returnedBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly path: string | null;
};

export function truncationFooter(
  returnedBytes: number,
  totalBytes: number,
  spillPath: string | null,
  nextStart: number
): string {
  const base = `[web_fetch tool: showing first ${returnedBytes} bytes of ${totalBytes}`;
  if (spillPath) {
    return `${base}; use read with path=${spillPath} and start=${nextStart} for the rest.]`;
  }
  return `${base}; full content unavailable.]`;
}

export function validatePublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`URL must be a valid public HTTP or HTTPS URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL must use http:// or https://: ${value}`);
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("URL must not contain embedded credentials.");
  }

  if (!isPublicHostname(url.hostname)) {
    throw new Error(
      `URL must use a public hostname or IP address (no localhost, .local, or RFC1918 ranges): ${url.hostname}`
    );
  }

  return url.href;
}

export async function formatOutcome(
  page: WebFetchPage,
  format: WebFetchResolvedFormat
): Promise<WebFetchOutcome> {
  const { body, returnedBytes, totalBytes, truncated } =
    OutputBudget.truncateUtf8(page.content, WEB_FETCH_INLINE_BYTES);
  const path = truncated
    ? await SpillCache.write(
        "fetch",
        format === "html" ? "html" : "md",
        page.content
      )
    : null;

  const lines = [
    `title: ${page.title}`,
    `url: ${page.url}`,
    `format: ${format}`,
    "content:",
    body,
  ];

  if (truncated) {
    const nextStart = Lines.continuationLine(body);
    lines.push(
      "",
      truncationFooter(returnedBytes, totalBytes, path, nextStart)
    );
  }

  return {
    text: lines.join("\n"),
    title: page.title,
    url: page.url,
    format,
    returnedBytes,
    totalBytes,
    truncated,
    path,
  };
}

export type ExecuteFetchInput = {
  readonly jina: JinaReaderClient;
  readonly webView: WebViewFetchClient;
  readonly url: string;
  readonly format: WebFetchFormat;
  readonly signal?: AbortSignal;
};

export async function executeFetch(
  input: ExecuteFetchInput
): Promise<WebFetchOutcome> {
  const { jina, webView, url, format, signal } = input;
  const fetchInput = {
    url,
    ...(signal === undefined ? {} : { signal }),
  };

  if (format === "html") {
    const page = await webView.fetchHtml(fetchInput);
    return formatOutcome(page, "html");
  }

  try {
    const page = await jina.fetchUrl(fetchInput);
    return await formatOutcome(page, "markdown");
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
  }

  try {
    const page = await webView.fetchMarkdown(fetchInput);
    return await formatOutcome(page, "markdown");
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error(`Failed to fetch: ${describeError(error)}`);
  }
}

function isPublicHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  if (normalized === "localhost" || normalized.endsWith(".local")) {
    return false;
  }

  const version = isIP(normalized);

  if (version === 4) {
    return isPublicIpv4(normalized);
  }

  if (version === 6) {
    return isPublicIpv6(normalized);
  }

  return normalized.length > 0;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.+$/u, "");

  if (lower.startsWith("[") && lower.endsWith("]")) {
    return lower.slice(1, -1);
  }

  return lower;
}

function isPublicIpv4(ip: string): boolean {
  const octets = ip.split(".").map((octet) => Number(octet));
  const [a = 0, b = 0, c = 0] = octets;

  if (a === 0 || a === 10 || a === 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }
  if (a === 192 && b === 168) {
    return false;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }
  if (a === 192 && b === 0 && c === 0) {
    return false;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return false;
  }

  return a < 224;
}

function isPublicIpv6(ip: string): boolean {
  const embedded = readEmbeddedIpv4(ip);

  if (embedded !== undefined && !isPublicIpv4(embedded)) {
    return false;
  }

  if (ip === "::" || ip === "::1") {
    return false;
  }

  const first = readFirstIpv6Segment(ip);

  if ((first & 0xfe00) === 0xfc00) {
    return false;
  }
  if ((first & 0xffc0) === 0xfe80) {
    return false;
  }

  return (first & 0xff00) !== 0xff00;
}

function readEmbeddedIpv4(ip: string): string | undefined {
  const match = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(ip);
  return match?.[1];
}

function readFirstIpv6Segment(ip: string): number {
  const first =
    ip
      .split(":")
      .find((segment) => segment.length > 0 && !segment.includes(".")) ?? "0";
  return Number.parseInt(first, 16);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
