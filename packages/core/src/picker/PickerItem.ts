/**
 * One completion row. Structurally identical to pi-tui's `AutocompleteItem`,
 * declared here because the picker runs wherever the agent's filesystem is —
 * the server, in a remote session — and must not depend on a terminal.
 */
export type PickerItem = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
};
