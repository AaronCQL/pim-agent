import { Errors } from "../../shared/Errors";
import { Json } from "../../shared/Json";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";
import type { WebFetchPage } from "./fetch";

type JinaReaderFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

type JinaReaderClientOptions = {
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly fetch?: JinaReaderFetch;
  readonly timeoutMs?: number;
};

type JinaReaderFetchInput = {
  readonly url: string;
  readonly signal?: AbortSignal;
};

class JinaReaderClientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "JinaReaderClientError";
  }
}

const defaultTimeoutMs = 20_000;

export class JinaReaderClient {
  private readonly endpoint: string;
  private readonly headers: Headers;
  private readonly ky: KyInstance;
  private readonly timeoutMs: number;

  public constructor(options: JinaReaderClientOptions = {}) {
    this.endpoint = normalizeEndpoint(options.endpoint ?? "https://r.jina.ai");
    this.headers = buildHeaders(options.apiKey);
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.ky = ky.create(
      options.fetch === undefined
        ? {}
        : { fetch: options.fetch as typeof fetch }
    );
  }

  public async fetchUrl(input: JinaReaderFetchInput): Promise<WebFetchPage> {
    if (input.signal?.aborted) {
      throw new JinaReaderClientError("Request aborted.");
    }

    let response: Response;

    try {
      response = await this.ky(`${this.endpoint}/${input.url}`, {
        headers: this.headers,
        timeout: this.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      const aborted = input.signal?.aborted ?? false;

      if (Errors.isAbort(error) || aborted) {
        throw new JinaReaderClientError("Request aborted.");
      }

      if (error instanceof TimeoutError) {
        throw new JinaReaderClientError(
          `Request timed out after ${this.timeoutMs}ms.`
        );
      }

      if (error instanceof HTTPError) {
        throw new JinaReaderClientError(
          `Request failed with HTTP ${error.response.status}: ${excerpt(stringifyErrorData(error.data))}`
        );
      }

      throw new JinaReaderClientError(
        `Request failed: ${Errors.describe(error)}`
      );
    }

    return parseResponse(input.url, response, await response.text());
  }
}

function buildHeaders(apiKey: string | undefined): Headers {
  const headers = new Headers({ Accept: "application/json" });

  if (apiKey !== undefined && apiKey.length > 0) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  return headers;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/u, "");
}

function parseResponse(
  requestedUrl: string,
  response: Response,
  responseText: string
): WebFetchPage {
  const contentType = response.headers.get("content-type") ?? "";
  const declaresJson =
    contentType.includes("application/json") || contentType.includes("+json");
  const parsedJson = Json.tryParseJson(responseText);

  if (parsedJson === undefined) {
    if (declaresJson) {
      throw new JinaReaderClientError("Response contained malformed JSON.");
    }

    return createPage({
      title: "",
      url: requestedUrl,
      content: responseText,
    });
  }

  return parseJsonPayload(requestedUrl, parsedJson);
}

function parseJsonPayload(
  requestedUrl: string,
  parsedJson: unknown
): WebFetchPage {
  const responseRecord = Json.asRecord(parsedJson);
  const payload = Json.asRecord(responseRecord?.["data"]) ?? responseRecord;

  if (payload === undefined) {
    throw new JinaReaderClientError("Response contained invalid payload.");
  }

  return createPage({
    title: optionalString(payload["title"], "title") ?? "",
    url: optionalString(payload["url"], "url") ?? requestedUrl,
    content: requiredString(payload["content"], "content"),
  });
}

function createPage(page: WebFetchPage): WebFetchPage {
  if (page.content.trim().length === 0) {
    throw new JinaReaderClientError("Response contained empty content.");
  }

  return page;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new JinaReaderClientError(
      `Response contained invalid payload: expected string ${name}.`
    );
  }

  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new JinaReaderClientError(
      `Response contained invalid payload: expected string ${name}.`
    );
  }

  return value;
}

function stringifyErrorData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (data === undefined) {
    return "";
  }

  return JSON.stringify(data);
}

function excerpt(text: string): string {
  const excerpt = text.replaceAll(/\s+/gu, " ").trim().slice(0, 200);

  return excerpt.length === 0 ? "empty response body" : excerpt;
}
