import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import bashExtension from "#core/extensions/bash/index";
import editExtension from "#core/extensions/edit/index";
import readExtension from "#core/extensions/read/index";

/**
 * Pim registers its tools through pi's extension API, and `Tools.wrap` files
 * each one's `toViewModel` in a process-wide registry as a side effect. Both
 * generating the fixture and re-projecting it need that registry populated —
 * without it every tool falls back to a generic view — so faking the one
 * method the extensions call is the whole adapter.
 */
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
