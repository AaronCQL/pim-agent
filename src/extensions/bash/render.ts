export const PREVIEW_LINES = 5;

export type MarkerStatus = "warning" | "error" | "success";

export function markerColorFor(
  isPartial: boolean,
  isError: boolean
): MarkerStatus {
  if (isPartial) {
    return "warning";
  }
  if (isError) {
    return "error";
  }
  return "success";
}

export function buildPreviewLines(
  body: string,
  maxLines: number
): { preview: string; overflow: number } {
  const lines = body.split("\n");
  if (lines.length <= maxLines) {
    return { preview: body, overflow: 0 };
  }
  return {
    preview: lines.slice(0, maxLines).join("\n"),
    overflow: lines.length - maxLines,
  };
}
