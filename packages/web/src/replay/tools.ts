import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import bashExtension from "#core/extensions/bash/index";
import editExtension from "#core/extensions/edit/index";
import readExtension from "#core/extensions/read/index";

/** Pim's tools; registering them fills the `toViewModel` registry the projection needs. */
export function pimTools(): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const api = {
    registerTool: (definition: ToolDefinition) => tools.push(definition),
  } as unknown as ExtensionAPI;

  readExtension(api);
  editExtension(api);
  bashExtension(api);
  return tools;
}
