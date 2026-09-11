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
  readonly os?: string;
};

type RunCommand = (cmd: ReadonlyArray<string>) => string | undefined;

type OsDescriptionOptions = {
  readonly platform?: typeof process.platform;
  readonly runCommand?: RunCommand;
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
      `- os: ${opts.os ?? describeOs()}`,
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

export function describeOs(options: OsDescriptionOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const runCommand =
    options.runCommand ??
    ((cmd) => {
      try {
        const result = Bun.spawnSync({ cmd: [...cmd] });
        if (result.exitCode !== 0) {
          return undefined;
        }

        const output = result.stdout.toString().trim();
        return output || undefined;
      } catch {
        return undefined;
      }
    });
  const unixName = (): string | undefined => runCommand(["uname", "-sr"]);

  if (platform === "linux") {
    const osRelease = runCommand(["cat", "/etc/os-release"]);
    if (osRelease) {
      const fields = new Map<string, string>();
      for (const line of osRelease.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }

        const equalsIndex = trimmed.indexOf("=");
        if (equalsIndex <= 0) {
          continue;
        }

        const key = trimmed.slice(0, equalsIndex);
        if (/^[A-Z0-9_]+$/.test(key)) {
          fields.set(key, unquoteValue(trimmed.slice(equalsIndex + 1)));
        }
      }

      const prettyName = fields.get("PRETTY_NAME")?.trim();
      if (prettyName) {
        return prettyName;
      }

      const name = fields.get("NAME")?.trim();
      const version =
        fields.get("VERSION")?.trim() ?? fields.get("VERSION_ID")?.trim();
      const described = [name, version].filter(Boolean).join(" ");
      if (described) {
        return described;
      }
    }

    const lsbRelease = runCommand(["lsb_release", "-ds"]);
    if (lsbRelease) {
      return unquoteValue(lsbRelease.trim());
    }

    return unixName() ?? platform;
  }

  if (platform === "darwin") {
    const swVers = runCommand(["sw_vers"]);
    if (swVers) {
      const fields = new Map<string, string>();
      for (const line of swVers.split(/\r?\n/)) {
        const match = line.match(/^([^:]+):\s*(.+)$/);
        const key = match?.[1]?.trim();
        const value = match?.[2]?.trim();
        if (key && value) {
          fields.set(key, value);
        }
      }

      const name = fields.get("ProductName") ?? "macOS";
      const version = fields.get("ProductVersion");
      return [name, version].filter(Boolean).join(" ") || platform;
    }

    return unixName() ?? platform;
  }

  if (platform === "win32") {
    const ver = runCommand(["cmd.exe", "/d", "/s", "/c", "ver"]);
    return ver?.replace(/\s+/g, " ").trim() || platform;
  }

  return unixName() ?? platform;
}

function unquoteValue(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const quote = value.charAt(0);
  if (
    (quote !== '"' && quote !== "'") ||
    value.charAt(value.length - 1) !== quote
  ) {
    return value;
  }

  const unquoted = value.slice(1, -1);
  return quote === "'" ? unquoted : unquoted.replace(/\\(["\\$`])/g, "$1");
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
