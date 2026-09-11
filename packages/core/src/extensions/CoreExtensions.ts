import type {
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";

import {
  ExtensionToggles,
  type PimExtensionName,
} from "../shared/ExtensionToggles";
import applyPatch from "./apply-patch/index";
import bash from "./bash/index";
import edit from "./edit/index";
import glob from "./glob/index";
import grep from "./grep/index";
import read from "./read/index";
import subagent from "./subagent/index";
import systemPrompt from "./system-prompt/index";
import todo from "./todo/index";
import webFetch from "./web-fetch/index";
import webSearch from "./web-search/index";
import write from "./write/index";

export type PimInlineExtension = {
  readonly name: PimExtensionName;
  readonly factory: ExtensionFactory;
};

// Enumerated, never globbed: the published tarball must not depend on a directory scan.
const list: readonly PimInlineExtension[] = [
  { name: "apply-patch", factory: applyPatch },
  { name: "bash", factory: bash },
  { name: "edit", factory: edit },
  { name: "glob", factory: glob },
  { name: "grep", factory: grep },
  { name: "read", factory: read },
  { name: "subagent", factory: subagent },
  { name: "system-prompt", factory: systemPrompt },
  { name: "todo", factory: todo },
  { name: "web-fetch", factory: webFetch },
  { name: "web-search", factory: webSearch },
  { name: "write", factory: write },
];

function gated(): InlineExtension[] {
  return list.map(({ name, factory }) => ({
    name,
    factory: ExtensionToggles.gate(name, factory),
  }));
}

export const CoreExtensions = { list, gated };
