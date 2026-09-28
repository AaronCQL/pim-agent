import { render } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { Mermaid, type Drawing } from "./Mermaid";

/** Fitted diagrams open below mermaid's own size, which is laid out for a page rather than a transcript. */
const FIT_SCALE = 0.75;
const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;

const BUTTON_CLASS =
  "flex size-7 shrink-0 items-center justify-center rounded-lg bg-neutral-850 text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50 disabled:opacity-40 disabled:pointer-events-none";

function ControlButton(props: {
  readonly label: string;
  readonly icon: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      class={BUTTON_CLASS}
      disabled={props.disabled}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        props.onPress();
      }}
    >
      <span class={`${props.icon} size-4`} aria-hidden="true" />
    </button>
  );
}

function clamp(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
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

function DiagramControls(props: {
  readonly pre: HTMLElement;
  readonly figure: HTMLElement;
  readonly canvas: HTMLElement;
  readonly drawing: Drawing;
}) {
  const { svg, width } = props.drawing;
  const [source, setSource] = createSignal(false);
  // Undefined while fitted to the pane; a scale once zoomed.
  const [scale, setScale] = createSignal<number | undefined>();

  const current = (): number => {
    const shown = svg.getBoundingClientRect().width;
    return scale() ?? (shown > 0 ? shown / width : FIT_SCALE);
  };
  const zoom = (factor: number): void => {
    setScale(clamp(current() * factor));
  };

  createEffect(scale, (zoomed) => {
    svg.style.width = `${width * (zoomed ?? FIT_SCALE)}px`;
    svg.style.maxWidth = zoomed === undefined ? "100%" : "none";
    svg.style.height = "auto";
  });
  onCleanup(fitToGrid(props.canvas, svg));

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
          label="Zoom out"
          icon="i-griddy-icons:search-minus"
          disabled={scale() !== undefined && scale()! <= MIN_SCALE}
          onPress={() => {
            zoom(1 / ZOOM_STEP);
          }}
        />
        <ControlButton
          label="Zoom in"
          icon="i-griddy-icons:search-plus"
          disabled={scale() !== undefined && scale()! >= MAX_SCALE}
          onPress={() => {
            zoom(ZOOM_STEP);
          }}
        />
      </Show>
      <ControlButton
        label={source() ? "Show diagram" : "Show source"}
        icon={source() ? "i-griddy-icons:image" : "i-griddy-icons:code"}
        onPress={flip}
      />
    </div>
  );
}

function mount(pre: HTMLElement, drawing: Drawing): () => void {
  const canvas = document.createElement("div");
  canvas.className = "overflow-x-auto";
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
    Mermaid.render(code.textContent ?? "").then(
      (drawing) => {
        if (live(pre)) {
          disposers.push(mount(pre, drawing));
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
