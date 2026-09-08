/** One completion row, structurally identical to pi-tui's `AutocompleteItem`. */
export type PickerItem = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
};
