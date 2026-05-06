import type { Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { DiffRenderer } from "../../shared/DiffRenderer";
import type { ToolDiff } from "../../shared/DiffLines";
import { Paths } from "../../shared/Paths";
import { type MarkerStatus, Renderer } from "../../shared/Renderer";

export type DiffStats = {
  readonly added: number;
  readonly removed: number;
};

export function formatTitlePath(path: string | undefined, cwd: string): string {
  return path ? Paths.displayRelative(path, cwd) : "...";
}

export function countDiffStats(diff: ToolDiff | undefined): DiffStats {
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

export function formatDiffStats(stats: DiffStats, theme: Theme): string {
  const parts: string[] = [];

  if (stats.added > 0) {
    parts.push(theme.fg("toolDiffAdded", `+${stats.added}`));
  }

  if (stats.removed > 0) {
    parts.push(theme.fg("toolDiffRemoved", `-${stats.removed}`));
  }

  return parts.join("/");
}

export function buildWriteTitle(args: {
  readonly path: string;
  readonly stats: DiffStats;
  readonly theme: Theme;
  readonly markerColor: MarkerStatus;
  readonly lastComponent: Component | undefined;
}): Text {
  const { path, stats, theme, markerColor, lastComponent } = args;
  const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const statsText = formatDiffStats(stats, theme);
  const head =
    theme.fg(markerColor, " ▪") +
    " " +
    theme.fg("toolTitle", theme.bold("Write") + ": " + path);

  text.setText(statsText ? `${head} ${statsText}` : head);
  return text;
}

export function buildDiffComponent(args: {
  readonly diff: ToolDiff;
  readonly theme: Theme;
  readonly lastComponent: Component | undefined;
}): Container {
  const { diff, theme, lastComponent } = args;
  const container = (lastComponent as Container | undefined) ?? new Container();
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
