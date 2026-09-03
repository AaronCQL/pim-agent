import {
  DynamicBorder,
  type ExtensionAPI,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type SettingItem,
  SettingsList,
} from "@earendil-works/pi-tui";
import {
  ExtensionToggles,
  type PimExtensionName,
} from "../../../../core/src/shared/ExtensionToggles";

const ENABLED = "enabled";
const DISABLED = "disabled";

const MAX_VISIBLE = 12;

/** Required extensions are left out entirely: a row that cannot change is noise. */
export async function menuItems(): Promise<SettingItem[]> {
  const disabled = new Set(await ExtensionToggles.disabled());
  return ExtensionToggles.NAMES.filter(
    (name) => !ExtensionToggles.isRequired(name)
  ).map((name) => ({
    id: name,
    label: name,
    description: ExtensionToggles.describe(name),
    currentValue: disabled.has(name) ? DISABLED : ENABLED,
    values: [ENABLED, DISABLED],
  }));
}

export function createToggleMenu(
  items: SettingItem[],
  onToggle: (name: PimExtensionName, disabled: boolean) => void,
  done: () => void
): Component {
  const container = new Container();
  container.addChild(new DynamicBorder());
  const list = new SettingsList(
    items,
    Math.min(items.length, MAX_VISIBLE),
    getSettingsListTheme(),
    (id, value) => {
      onToggle(id as PimExtensionName, value === DISABLED);
    },
    done
  );
  container.addChild(list);
  container.addChild(new DynamicBorder());
  return {
    invalidate: () => container.invalidate(),
    render: (width) => container.render(width),
    handleInput: (data) => list.handleInput(data),
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("pim", {
    description: "Enable or disable pim extensions",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/pim needs the interactive TUI", "warning");
        return;
      }

      // Each keypress writes straight away; the whole menu is one reload.
      const writes: Promise<void>[] = [];
      const items = await menuItems();
      await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) =>
        createToggleMenu(
          items,
          (name, disabled) => {
            writes.push(ExtensionToggles.setDisabled(name, disabled));
          },
          () => done()
        )
      );
      if (writes.length === 0) {
        return;
      }
      await Promise.all(writes);

      // Re-invokes every inline factory, so the gate in `bin/pim.ts` applies
      // the new state now instead of at the next launch. `ctx` is stale after.
      await ctx.reload();
    },
  });
}
