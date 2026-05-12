import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import type { ToolDiff } from "./DiffLines";
import { DiffRenderer } from "./DiffRenderer";
import { type MarkerStatus, Renderer } from "./Renderer";

export type DiffStats = {
  readonly added: number;
  readonly removed: number;
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
}
