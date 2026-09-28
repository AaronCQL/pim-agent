import type { Mermaid as MermaidApi } from "mermaid";

const THEME = {
  darkMode: true,
  background: "#101010",
  fontFamily: '"Commit Mono", ui-monospace, monospace',
  fontSize: "14px",
  primaryColor: "#262626",
  primaryTextColor: "#e5e5e5",
  primaryBorderColor: "#525252",
  secondaryColor: "#1e1b4b",
  tertiaryColor: "#171717",
  lineColor: "#a3a3a3",
  edgeLabelBackground: "#101010",
  dropShadow: "none",
  textColor: "#e5e5e5",
  noteBkgColor: "#262626",
  noteTextColor: "#d4d4d4",
  noteBorderColor: "#525252",
};

// Past this a label wraps, which mermaid decides by comparing a measured width
// to it with `===`: a fractional device scale misses, and the label is clipped
// instead. Wide enough never to be reached, labels break at `<br/>` alone.
const UNWRAPPED = { wrappingWidth: 10_000 };

let loading: Promise<MermaidApi> | undefined;
let rendered = 0;

async function load(): Promise<MermaidApi> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    fontFamily: THEME.fontFamily,
    themeVariables: THEME,
    flowchart: UNWRAPPED,
    state: UNWRAPPED,
  });
  // Labels are measured as they are laid out, so the face must be in first.
  await document.fonts.ready;
  return mermaid;
}

function mermaid(): Promise<MermaidApi> {
  loading ??= load().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

/** A rendered diagram and the size mermaid laid it out at, in CSS pixels. */
export type Drawing = {
  readonly svg: SVGSVGElement;
  readonly width: number;
  readonly height: number;
};

/** `source` drawn as SVG; rejects with mermaid's message when it will not parse. */
async function render(source: string): Promise<Drawing> {
  const api = await mermaid();
  rendered += 1;
  const { svg } = await api.render(`pim-mermaid-${rendered}`, source);
  const template = document.createElement("template");
  template.innerHTML = svg;
  const element = template.content.querySelector("svg");
  if (element === null) {
    throw new Error("mermaid produced no diagram");
  }
  const [, , width = 0, height = 0] = (element.getAttribute("viewBox") ?? "")
    .split(/[\s,]+/)
    .map(Number);
  element.removeAttribute("width");
  element.removeAttribute("height");
  element.style.removeProperty("max-width");
  return { svg: element, width, height };
}

export const Mermaid = { render };
