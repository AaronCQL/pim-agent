import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ExtensionToggles } from "../../../../core/src/shared/ExtensionToggles";
import { PimSettings } from "../../../../core/src/shared/PimSettings";

const RESTART_HINT = "Restart pim for this to take effect.";

function label(name: string, disabled: boolean): string {
  const state = ExtensionToggles.isRequired(name)
    ? "required"
    : disabled
      ? "disabled"
      : "enabled";
  return `${name.padEnd(18)} ${state}`;
}

export async function statusLines(): Promise<readonly string[]> {
  const disabled = new Set(await ExtensionToggles.disabled());
  return ExtensionToggles.NAMES.map((name) => label(name, disabled.has(name)));
}

async function toggleAndReport(name: string): Promise<string> {
  const result = await ExtensionToggles.toggle(name);
  return `${result.name} ${result.disabled ? "disabled" : "enabled"}. ${RESTART_HINT}`;
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("extensions", {
    description: "Enable or disable individual pim extensions",
    getArgumentCompletions: (prefix) =>
      ExtensionToggles.NAMES.filter(
        (name) =>
          !ExtensionToggles.isRequired(name) && name.startsWith(prefix.trim())
      ).map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const name = args.trim();
      if (name.length === 0) {
        const lines = await statusLines();
        const choice = await ctx.ui.select(
          `Toggle a pim extension (${PimSettings.path()})`,
          [...lines]
        );
        if (choice === undefined) {
          return;
        }
        const chosen = choice.split(/\s+/, 1)[0] ?? "";
        if (ExtensionToggles.isRequired(chosen)) {
          ctx.ui.notify(
            `${chosen} is required by pim and cannot be disabled`,
            "warning"
          );
          return;
        }
        ctx.ui.notify(await toggleAndReport(chosen), "info");
        return;
      }

      try {
        ctx.ui.notify(await toggleAndReport(name), "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      }
    },
  });
}
