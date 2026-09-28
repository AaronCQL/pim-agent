import { render } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";

import { Lightbox } from "../ui/Lightbox";
import { Mermaid, type Drawing } from "./Mermaid";

const INLINE_LABEL_PX = 11;

const BUTTON_CLASS =
  "flex size-7 shrink-0 items-center justify-center rounded-lg bg-neutral-850 text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50";

function ControlButton(props: {
  readonly label: string;
  readonly icon: string;
  readonly onPress: () => void;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      class={BUTTON_CLASS}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        props.onPress();
      }}
    >
      <span class={`${props.icon} size-4`} aria-hidden="true" />
    </button>
  );
}

// Sized up to whole rows, so the prose below it stays on the --line grid.
function fitToGrid(canvas: HTMLElement, svg: SVGSVGElement): () => void {
  const resize = (): void => {
    const height = svg.getBoundingClientRect().height;
    canvas.style.height = `round(up, calc(${height}px + var(--scrollbar)), var(--line))`;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(svg);
  return () => {
    observer.disconnect();
  };
}

function fill(svg: SVGSVGElement): SVGSVGElement {
  svg.style.width = "100%";
  svg.style.height = "100%";
  return svg;
}

/** The diagram full screen, drawn afresh: mermaid scopes its styles and markers by id, which a copy would share. */
function DiagramLightbox(props: {
  readonly source: string;
  readonly onClose: () => void;
}) {
  const [drawing, setDrawing] = createSignal<Drawing>();
  Mermaid.render(props.source).then(setDrawing, props.onClose);

  return (
    <Lightbox label="Diagram" size={drawing()} onClose={props.onClose}>
      <div class="size-full rounded-lg bg-neutral-925">
        {drawing() === undefined ? undefined : fill(drawing()!.svg)}
      </div>
    </Lightbox>
  );
}

function DiagramControls(props: {
  readonly pre: HTMLElement;
  readonly figure: HTMLElement;
  readonly canvas: HTMLElement;
  readonly drawing: Drawing;
  readonly source: string;
}) {
  const { svg, width } = props.drawing;
  const [source, setSource] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);

  svg.style.width = `${(width * INLINE_LABEL_PX) / Mermaid.FONT_PX}px`;
  svg.style.height = "auto";
  onCleanup(fitToGrid(props.canvas, svg));

  const expand = (): void => {
    setExpanded(true);
  };
  props.canvas.addEventListener("click", expand);
  onCleanup(() => {
    props.canvas.removeEventListener("click", expand);
  });

  const flip = (): void => {
    const next = !source();
    setSource(next);
    props.pre.hidden = !next;
    props.figure.hidden = next;
  };

  return (
    <div class="absolute right-8 top-0 flex gap-1">
      <Show when={!source()}>
        <ControlButton
          label="Expand diagram"
          icon="i-griddy-icons:maximize-alt-03"
          onPress={expand}
        />
      </Show>
      <ControlButton
        label={source() ? "Show diagram" : "Show source"}
        icon={source() ? "i-griddy-icons:image" : "i-griddy-icons:code"}
        onPress={flip}
      />
      <Show when={expanded()}>
        <DiagramLightbox
          source={props.source}
          onClose={() => {
            setExpanded(false);
          }}
        />
      </Show>
    </div>
  );
}

function mount(pre: HTMLElement, drawing: Drawing, source: string): () => void {
  const canvas = document.createElement("div");
  canvas.className = "cursor-zoom-in overflow-x-auto";
  canvas.append(drawing.svg);
  const figure = document.createElement("div");
  figure.className = "pim-diagram";
  figure.append(canvas);
  pre.before(figure);
  pre.hidden = true;
  return render(
    () => (
      <DiagramControls
        pre={pre}
        figure={figure}
        canvas={canvas}
        drawing={drawing}
        source={source}
      />
    ),
    pre.parentElement!
  );
}

function showError(pre: HTMLElement, error: unknown): void {
  const note = document.createElement("p");
  note.className = "text-neutral-500";
  const message = error instanceof Error ? error.message : String(error);
  note.textContent = `mermaid: ${message.split("\n")[0]}`;
  pre.after(note);
}

/** Closed mermaid fences drawn in place; runs after the copy buttons, since a diagram joins its fence's wrapper. */
function draw(
  host: HTMLElement,
  open: Element | undefined,
  disposers: (() => void)[],
  live: (pre: HTMLElement) => boolean
): void {
  for (const code of host.querySelectorAll("pre > code.mermaid")) {
    const pre = code.parentElement!;
    if (pre === open || pre.hasAttribute("data-diagram")) {
      continue;
    }
    pre.setAttribute("data-diagram", "");
    const source = code.textContent ?? "";
    Mermaid.render(source).then(
      (drawing) => {
        if (live(pre)) {
          disposers.push(mount(pre, drawing, source));
        }
      },
      (error: unknown) => {
        if (live(pre)) {
          showError(pre, error);
        }
      }
    );
  }
}

export const Diagrams = { draw };
