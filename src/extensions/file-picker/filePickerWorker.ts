import type { FileCandidate } from "./catalog";
import { loadRelative } from "./catalog";
import type {
  FilePickerWorkerRequest,
  FilePickerWorkerResponse,
} from "./filePickerWorkerMessages";
import { rank } from "./ranker";

let cachedRelative: readonly FileCandidate[] | undefined;

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const refreshRelative = async (id: number, root: string): Promise<void> => {
  try {
    cachedRelative = await loadRelative({ root });
    self.postMessage({
      id,
      type: "refreshRelative",
      ok: true,
    } satisfies FilePickerWorkerResponse);
  } catch (error) {
    if (cachedRelative === undefined) {
      cachedRelative = [];
    }
    self.postMessage({
      id,
      type: "refreshRelative",
      ok: false,
      error: toErrorMessage(error),
    } satisfies FilePickerWorkerResponse);
  }
};

const rankSuggestions = async (
  id: number,
  query: string,
  limit: number | undefined
): Promise<void> => {
  try {
    const items = await rank(query, { cachedRelative, limit });
    self.postMessage({
      id,
      type: "rank",
      ok: true,
      items,
    } satisfies FilePickerWorkerResponse);
  } catch (error) {
    self.postMessage({
      id,
      type: "rank",
      ok: false,
      error: toErrorMessage(error),
    } satisfies FilePickerWorkerResponse);
  }
};

self.onmessage = (event: MessageEvent<FilePickerWorkerRequest>): void => {
  const message = event.data;
  switch (message.type) {
    case "refreshRelative":
      void refreshRelative(message.id, message.root);
      break;
    case "rank":
      void rankSuggestions(message.id, message.query, message.limit);
      break;
  }
};
