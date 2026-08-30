import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type {
  FilePickerSuggestionEngine,
  RankFilePickerOptions,
} from "./FilePickerSuggestionEngine";
import type {
  FilePickerWorkerRequest,
  FilePickerWorkerResponse,
} from "./filePickerWorkerMessages";

type PendingRefresh = {
  readonly resolve: () => void;
};

type RankRequest = {
  readonly id: number;
  readonly query: string;
  readonly limit: number | undefined;
  readonly resolve: (items: readonly AutocompleteItem[] | undefined) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
  settled: boolean;
};

export class WorkerFilePickerSuggestionEngine implements FilePickerSuggestionEngine {
  private worker: Worker | undefined;
  private nextRequestId = 0;
  private refresh: Promise<void> | undefined;
  private activeRank: RankRequest | undefined;
  private queuedRank: RankRequest | undefined;
  private readonly pendingRefreshes = new Map<number, PendingRefresh>();

  public constructor(private readonly root: string) {}

  public refreshRelative(): Promise<void> {
    this.refresh ??= this.sendRefreshRelative().finally(() => {
      this.refresh = undefined;
    });
    return this.refresh;
  }

  public rank(
    query: string,
    options: RankFilePickerOptions
  ): Promise<readonly AutocompleteItem[] | undefined> {
    if (options.signal?.aborted === true) {
      return Promise.resolve([]);
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      let request: RankRequest;
      const abortListener = (): void => {
        this.abortRank(request);
      };
      request = {
        id,
        query,
        limit: options.limit,
        resolve,
        reject,
        signal: options.signal,
        abortListener: options.signal === undefined ? undefined : abortListener,
        settled: false,
      };

      if (options.signal !== undefined) {
        options.signal.addEventListener("abort", abortListener, { once: true });
      }

      this.enqueueRank(request);
    });
  }

  public dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.failPending(new Error("file picker worker disposed"));
  }

  private enqueueRank(request: RankRequest): void {
    if (this.activeRank === undefined) {
      this.sendRank(request);
      return;
    }

    this.resolveRank(this.activeRank, []);
    if (this.queuedRank !== undefined) {
      this.resolveRank(this.queuedRank, []);
    }
    this.queuedRank = request;
  }

  private sendRank(request: RankRequest): void {
    this.activeRank = request;
    try {
      this.post({
        id: request.id,
        type: "rank",
        query: request.query,
        limit: request.limit,
      });
    } catch (error) {
      if (this.activeRank === request) {
        this.activeRank = undefined;
      }
      this.rejectRank(request, error);
      this.sendQueuedRank();
    }
  }

  private sendQueuedRank(): void {
    const request = this.queuedRank;
    if (request === undefined || this.activeRank !== undefined) {
      return;
    }

    this.queuedRank = undefined;
    if (request.settled) {
      this.sendQueuedRank();
      return;
    }

    this.sendRank(request);
  }

  private abortRank(request: RankRequest): void {
    if (this.queuedRank === request) {
      this.queuedRank = undefined;
    }
    this.resolveRank(request, []);
  }

  private resolveRank(
    request: RankRequest,
    items: readonly AutocompleteItem[] | undefined
  ): void {
    if (request.settled) {
      return;
    }

    request.settled = true;
    this.removeAbortListener(request);
    request.resolve(items);
  }

  private rejectRank(request: RankRequest, error: unknown): void {
    if (request.settled) {
      return;
    }

    request.settled = true;
    this.removeAbortListener(request);
    request.reject(error);
  }

  private sendRefreshRelative(): Promise<void> {
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingRefreshes.set(id, { resolve });
      try {
        this.post({
          id,
          type: "refreshRelative",
          root: this.root,
        });
      } catch {
        this.pendingRefreshes.delete(id);
        resolve();
      }
    });
  }

  private post(message: FilePickerWorkerRequest): void {
    this.currentWorker().postMessage(message);
  }

  private currentWorker(): Worker {
    if (this.worker !== undefined) {
      return this.worker;
    }

    const worker = new Worker(
      new URL("./filePickerWorker.ts", import.meta.url),
      {
        type: "module",
      }
    );
    worker.onmessage = (
      event: MessageEvent<FilePickerWorkerResponse>
    ): void => {
      this.handleMessage(event.data);
    };
    worker.onerror = (event): void => {
      this.worker = undefined;
      worker.terminate();
      this.failPending(new Error(event.message));
    };
    this.worker = worker;
    return worker;
  }

  private handleMessage(message: FilePickerWorkerResponse): void {
    switch (message.type) {
      case "refreshRelative":
        this.handleRefreshRelativeMessage(message);
        break;
      case "rank":
        this.handleRankMessage(message);
        break;
    }
  }

  private handleRefreshRelativeMessage(
    message: Extract<
      FilePickerWorkerResponse,
      { readonly type: "refreshRelative" }
    >
  ): void {
    const pending = this.pendingRefreshes.get(message.id);
    if (pending === undefined) {
      return;
    }

    this.pendingRefreshes.delete(message.id);
    pending.resolve();
  }

  private handleRankMessage(
    message: Extract<FilePickerWorkerResponse, { readonly type: "rank" }>
  ): void {
    const request = this.activeRank;
    if (request === undefined || request.id !== message.id) {
      return;
    }

    this.activeRank = undefined;
    if (message.ok) {
      this.resolveRank(request, message.items);
    } else {
      this.rejectRank(request, new Error(message.error));
    }
    this.sendQueuedRank();
  }

  private failPending(error: unknown): void {
    for (const [id, pending] of this.pendingRefreshes) {
      this.pendingRefreshes.delete(id);
      pending.resolve();
    }

    if (this.activeRank !== undefined) {
      this.rejectRank(this.activeRank, error);
      this.activeRank = undefined;
    }
    if (this.queuedRank !== undefined) {
      this.rejectRank(this.queuedRank, error);
      this.queuedRank = undefined;
    }
  }

  private removeAbortListener(request: RankRequest): void {
    if (request.signal !== undefined && request.abortListener !== undefined) {
      request.signal.removeEventListener("abort", request.abortListener);
    }
  }
}
