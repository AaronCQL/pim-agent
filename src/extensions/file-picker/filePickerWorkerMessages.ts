import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type FilePickerWorkerRequest =
  | {
      readonly id: number;
      readonly type: "refreshRelative";
      readonly root: string;
    }
  | {
      readonly id: number;
      readonly type: "rank";
      readonly query: string;
      readonly limit?: number;
    };

export type FilePickerWorkerResponse =
  | {
      readonly id: number;
      readonly type: "refreshRelative";
      readonly ok: true;
    }
  | {
      readonly id: number;
      readonly type: "refreshRelative";
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly id: number;
      readonly type: "rank";
      readonly ok: true;
      readonly items: readonly AutocompleteItem[] | undefined;
    }
  | {
      readonly id: number;
      readonly type: "rank";
      readonly ok: false;
      readonly error: string;
    };
