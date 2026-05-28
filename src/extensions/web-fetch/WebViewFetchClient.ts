import { platform } from "node:os";
import type { WebFetchPage } from "./fetch";
import { createMarkdownSnapshotScript } from "./WebViewMarkdownSnapshot";

export type WebViewLike = {
  readonly url: string;
  readonly title: string;
  navigate: (url: string) => Promise<void>;
  evaluate: <T = unknown>(script: string) => Promise<T>;
  close: () => void;
};

export type WebViewFactory = () => WebViewLike;

type WebViewFetchClientOptions = {
  readonly factory?: WebViewFactory;
  readonly timeoutMs?: number;
};

type WebViewFetchInput = {
  readonly url: string;
  readonly signal?: AbortSignal;
};

type WebViewSnapshot = {
  readonly title: string;
  readonly url: string;
  readonly content: string;
};

class WebViewFetchClientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WebViewFetchClientError";
  }
}

export class WebViewFetchClient {
  private static readonly defaultTimeoutMs = 20_000;

  private readonly factory: WebViewFactory;
  private readonly timeoutMs: number;

  public constructor(options: WebViewFetchClientOptions = {}) {
    this.factory = options.factory ?? WebViewFetchClient.defaultFactory;
    this.timeoutMs = options.timeoutMs ?? WebViewFetchClient.defaultTimeoutMs;
  }

  private static defaultFactory(): WebViewLike {
    return new Bun.WebView(
      platform() === "darwin" ? undefined : { backend: "chrome" }
    );
  }

  public async fetchHtml(input: WebViewFetchInput): Promise<WebFetchPage> {
    return this.capturePage(input, WebViewFetchClient.htmlSnapshotScript());
  }

  public async fetchMarkdown(input: WebViewFetchInput): Promise<WebFetchPage> {
    return this.capturePage(input, createMarkdownSnapshotScript());
  }

  private async capturePage(
    input: WebViewFetchInput,
    snapshotScript: string
  ): Promise<WebFetchPage> {
    const signal = input.signal;

    if (signal?.aborted) {
      throw new WebViewFetchClientError("Request aborted.");
    }

    let view: WebViewLike;

    try {
      view = this.factory();
    } catch (error) {
      throw new WebViewFetchClientError(
        `Request failed: ${describeError(error)}`
      );
    }

    let aborted = false;
    let timedOut = false;
    const onAbort = () => {
      aborted = true;
      WebViewFetchClient.safeClose(view);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      WebViewFetchClient.safeClose(view);
    }, this.timeoutMs);

    const checkInterrupted = (): void => {
      if (timedOut) {
        throw new WebViewFetchClientError(
          `Request timed out after ${this.timeoutMs}ms.`
        );
      }
      if (aborted) {
        throw new WebViewFetchClientError("Request aborted.");
      }
    };

    try {
      await view.navigate(input.url);
      checkInterrupted();

      const snapshot = WebViewFetchClient.readSnapshot(
        await view.evaluate<unknown>(snapshotScript)
      );

      if (snapshot.content.trim().length === 0) {
        throw new WebViewFetchClientError("Response contained empty content.");
      }

      const finalUrl =
        snapshot.url.length > 0
          ? snapshot.url
          : view.url.length > 0
            ? view.url
            : input.url;

      return {
        title: snapshot.title,
        url: finalUrl,
        content: snapshot.content,
      };
    } catch (error) {
      checkInterrupted();

      if (error instanceof WebViewFetchClientError) {
        throw error;
      }

      throw new WebViewFetchClientError(
        `Request failed: ${describeError(error)}`
      );
    } finally {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      WebViewFetchClient.safeClose(view);
    }
  }

  private static htmlSnapshotScript(): string {
    return String.raw`(() => ({
      title: document.title,
      url: location.href,
      content: document.documentElement.outerHTML,
    }))()`;
  }

  private static readSnapshot(value: unknown): WebViewSnapshot {
    if (typeof value !== "object" || value === null) {
      throw new WebViewFetchClientError("Response contained invalid payload.");
    }

    const record = value as Record<string, unknown>;

    if (typeof record["content"] !== "string") {
      throw new WebViewFetchClientError("Response contained invalid payload.");
    }

    return {
      content: record["content"],
      title: typeof record["title"] === "string" ? record["title"] : "",
      url: typeof record["url"] === "string" ? record["url"] : "",
    };
  }

  private static safeClose(view: WebViewLike): void {
    try {
      view.close();
    } catch {
      // close() throws if already closed; treat as idempotent.
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
