import { McpClientError } from "../../../shared/McpClient";
import { ExaMcpClient } from "../ExaMcpClient";
import {
  isAbortError,
  ProviderQuotaError,
  ProviderSearchError,
  type ProviderSearchInput,
  type SearchProvider,
  type SearchResult,
} from "./SearchProvider";

export type ExaProviderOptions = {
  readonly apiKey?: string;
  readonly client?: ExaMcpClient;
};

export class ExaProvider implements SearchProvider {
  public readonly name = "exa";

  private readonly client: ExaMcpClient;

  public constructor(options: ExaProviderOptions = {}) {
    this.client =
      options.client ??
      new ExaMcpClient(
        options.apiKey === undefined ? {} : { apiKey: options.apiKey }
      );
  }

  public async search(
    input: ProviderSearchInput
  ): Promise<readonly SearchResult[]> {
    try {
      return await this.client.search({
        query: input.query,
        numResults: input.numResults,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) {
        throw error;
      }

      if (error instanceof McpClientError && error.status === 429) {
        throw new ProviderQuotaError(
          this.name,
          "Exa rejected the request: free keyless tier limit reached."
        );
      }

      throw new ProviderSearchError(this.name, describeError(error));
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
