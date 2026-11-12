import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { JobLine } from "#core/extensions/subagent/JobLine";
import type { JobView } from "#core/extensions/subagent/SubagentJobs";
import { Format } from "#core/shared/Format";
import { AnsiPainter } from "#core/view/AnsiPainter";

const MAX_ROWS = 5;
const PAD = " ";
const ELLIPSIS = "…";

/** The elapsed time sits at the right edge; the stats are clipped to leave it room. */
function row(job: JobView, now: number, theme: Theme, width: number): string {
  const parts = JobLine.parts(job, now);
  const head = `${theme.fg("accent", parts.handle)}${theme.fg("muted", ":")} `;
  const room = width - visibleWidth(head) - visibleWidth(parts.elapsed) - 1;
  const stats = truncateToWidth(
    parts.stats
      .map((span) => {
        const color = AnsiPainter.themeColorFor(span.tone);
        return color === undefined ? span.text : theme.fg(color, span.text);
      })
      .join(JobLine.SEPARATOR),
    Math.max(1, room),
    ELLIPSIS
  );
  const gap = Math.max(
    1,
    width -
      visibleWidth(head) -
      visibleWidth(stats) -
      visibleWidth(parts.elapsed)
  );
  return head + stats + " ".repeat(gap) + theme.fg("muted", parts.elapsed);
}

function heading(count: number, theme: Theme): string {
  return (
    theme.bold(Format.count(count, "subagent job")) +
    theme.fg("muted", ` · ${keyText("app.interrupt")} to stop`)
  );
}

/** One heading, then a row per job, at most `MAX_ROWS` of them; each line fits `width`. */
function lines(
  jobs: readonly JobView[],
  now: number,
  theme: Theme,
  width: number
): string[] {
  if (jobs.length === 0) {
    return [];
  }
  const shown =
    jobs.length > MAX_ROWS ? jobs.slice(0, MAX_ROWS - 1) : jobs.slice();
  const hidden = jobs.length - shown.length;
  const inner = Math.max(1, width - PAD.length * 2);
  return [
    heading(jobs.length, theme),
    ...shown.map((job) => row(job, now, theme, inner)),
    ...(hidden > 0 ? [theme.fg("muted", `… +${hidden} more`)] : []),
  ].map((line) => PAD + truncateToWidth(line, inner, ELLIPSIS));
}

export const JobsWidget = { MAX_ROWS, lines };
