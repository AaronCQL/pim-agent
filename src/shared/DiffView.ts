import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import type { ToolDiff } from "./DiffLines";
import { DiffRenderer } from "./DiffRenderer";
import { Paths } from "./Paths";
import { type MarkerStatus, Renderer } from "./Renderer";

export type DiffStats = {
  readonly added: number;
  readonly removed: number;
};

export type DiffRenderState = {
  titleComponent?: Component;
  path?: string;
};

export class DiffView {
  public static countStats(diff: ToolDiff | undefined): DiffStats {
    if (!diff) {
      return { added: 0, removed: 0 };
    }

    let added = 0;
    let removed = 0;

    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added") {
          added += 1;
        } else if (line.kind === "removed") {
          removed += 1;
        }
      }
    }

    return { added, removed };
  }

  public static formatStats(stats: DiffStats, theme: Theme): string {
    const parts: string[] = [];

    if (stats.added > 0) {
      parts.push(theme.fg("toolDiffAdded", `+${stats.added}`));
    }

    if (stats.removed > 0) {
      parts.push(theme.fg("toolDiffRemoved", `-${stats.removed}`));
    }

    return parts.join("/");
  }

  public static buildTitle(args: {
    readonly label: string;
    readonly path: string;
    readonly stats: DiffStats;
    readonly theme: Theme;
    readonly markerColor: MarkerStatus;
    readonly lastComponent: Component | undefined;
  }): Component {
    const { label, path, stats, theme, markerColor, lastComponent } = args;
    const statsText = DiffView.formatStats(stats, theme);

    return Renderer.renderToolCallTitle({
      label,
      title: statsText ? `${path} ${statsText}` : path,
      theme,
      context: {
        lastComponent,
        isPartial: markerColor === "warning",
        isError: markerColor === "error",
      },
    });
  }

  public static buildBlock(args: {
    readonly diff: ToolDiff;
    readonly theme: Theme;
    readonly lastComponent: Component | undefined;
  }): Container {
    const { diff, theme, lastComponent } = args;
    const container =
      (lastComponent as Container | undefined) ?? new Container();
    container.clear();

    const body = DiffRenderer.render({ toolDiff: diff, theme });

    if (!body) {
      return container;
    }

    container.addChild(
      Renderer.makePrefixedBlock({
        text: body,
        theme,
        prefix: Renderer.TIGHT_PREFIX,
      })
    );

    container.invalidate();
    return container;
  }

  public static renderDiffCall(args: {
    readonly label: string;
    readonly rawPath: string | undefined;
    readonly theme: Theme;
    readonly context: {
      readonly state: DiffRenderState;
      readonly cwd: string;
      readonly isPartial: boolean;
      readonly isError: boolean;
      readonly lastComponent: Component | undefined;
    };
  }): Component {
    const { label, rawPath, theme, context } = args;
    const state = context.state;
    const display = Paths.titleOr(rawPath, context.cwd);
    state.path = display;
    const markerColor = Renderer.markerColorFor(
      Boolean(context.isPartial),
      Boolean(context.isError)
    );
    const text = DiffView.buildTitle({
      label,
      path: display,
      stats: { added: 0, removed: 0 },
      theme,
      markerColor,
      lastComponent: context.lastComponent,
    });
    state.titleComponent = text;
    return text;
  }

  public static renderDiffResult(args: {
    readonly label: string;
    readonly result: AgentToolResult<unknown>;
    readonly options: ToolRenderResultOptions;
    readonly theme: Theme;
    readonly context: {
      readonly state: DiffRenderState;
      readonly isError: boolean;
      readonly lastComponent: Component | undefined;
    };
    readonly previewLines: number;
  }): Component {
    const { label, result, options, theme, context, previewLines } = args;
    const state = context.state;
    const fallback =
      (context.lastComponent as Container | undefined) ?? new Container();

    if (options.isPartial) {
      fallback.clear();
      return fallback;
    }

    if (context.isError) {
      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context: { ...context, isPartial: false },
        previewLines,
      });
    }

    const details = result.details as { readonly diff?: ToolDiff } | undefined;
    const diff = details?.diff;
    const stats = DiffView.countStats(diff);

    if (state.titleComponent && state.path !== undefined) {
      DiffView.buildTitle({
        label,
        path: state.path,
        stats,
        theme,
        markerColor: Renderer.markerColorFor(false, false),
        lastComponent: state.titleComponent,
      });
    }

    if (!diff) {
      fallback.clear();
      return fallback;
    }

    return DiffView.buildBlock({
      diff,
      theme,
      lastComponent: context.lastComponent,
    });
  }
}
