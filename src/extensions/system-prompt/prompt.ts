import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type BuildOptions = {
  readonly model?: ExtensionContext["model"];
  readonly cwd: string;
  readonly contextFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly skillsBlock: string;
  readonly toolGuidelines: ReadonlyArray<string>;
  readonly appendSystemPrompt?: string;
  readonly customPrompt?: string;
};

function dynamicGuidelines(): ReadonlyArray<string> {
  const guidelines: string[] = [];
  if (Bun.which("gh")) {
    guidelines.push(
      "Always prefer `gh` CLI instead of raw API calls when viewing GitHub content (eg. PRs, issues, comments)."
    );
  }
  return guidelines;
}

export function buildSystemPrompt(opts: BuildOptions): string {
  const sections: string[] = [];

  if (opts.customPrompt && opts.customPrompt.trim().length > 0) {
    sections.push(opts.customPrompt);
  } else {
    sections.push(
      [
        "<system_instructions>",
        "You are pim (Pi IMproved), a Bun-native, opinionated extension pack for the [pi agent harness](https://pi.dev/).",
        ...opts.toolGuidelines.map((g) => `- ${g}`),
        ...dynamicGuidelines().map((g) => `- ${g}`),
        "</system_instructions>",
      ].join("\n")
    );
  }

  const model = opts.model
    ? `${opts.model.id} via ${opts.model.provider}`
    : "unknown";
  sections.push(
    [
      "<environment>",
      `- cwd: ${opts.cwd}`,
      `- platform: ${process.platform}`,
      `- model: ${model}`,
      `- datetime: ${formatDatetime(new Date())}`,
      "</environment>",
    ].join("\n")
  );

  if (opts.contextFiles.length > 0) {
    const files = opts.contextFiles
      .map(
        ({ path, content }) =>
          `<file path="${escapeXmlAttr(path)}">\n${content}\n</file>`
      )
      .join("\n");
    sections.push(`<project_instructions>\n${files}\n</project_instructions>`);
  }

  if (opts.skillsBlock) {
    sections.push(opts.skillsBlock.trimStart());
  }

  if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim().length > 0) {
    sections.push(opts.appendSystemPrompt);
  }

  return sections.join("\n\n");
}

function formatDatetime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`;
  const iso =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offset}`;
  const day = d.toLocaleDateString("en-US", { weekday: "long" });
  return `${iso} (${day})`;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
