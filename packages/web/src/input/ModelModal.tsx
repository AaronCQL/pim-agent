import { createEffect, createMemo, createSignal, Show } from "solid-js";

import type { ModelCatalogue, SessionStore } from "../session/SessionStore";
import { Menu, type MenuOption } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { Section } from "../ui/Section";

const FOLLOW = { value: "", label: "Inherit" } satisfies MenuOption;

/** The main agent's model and effort, and the ones its subagents run on. */
export function ModelModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: SessionStore;
}) {
  const [catalogue, setCatalogue] = createSignal<ModelCatalogue>({
    models: [],
    thinkingLevels: [],
  });
  createEffect(
    () => props.open,
    (open) => {
      if (open) {
        void props.store.listModels().then(setCatalogue);
      }
    }
  );

  const state = () => props.store.state;
  const models = createMemo<readonly MenuOption[]>(() =>
    catalogue().models.map(({ id, label, provider }) => ({
      value: id,
      label,
      tag: provider,
    }))
  );
  const levelsOf = (model: string): readonly MenuOption[] =>
    (
      catalogue().models.find(({ id }) => id === model)?.thinkingLevels ??
      catalogue().thinkingLevels
    ).map((level) => ({ value: level, label: level }));
  const levels = createMemo(() => levelsOf(state().model));
  const subagentModels = createMemo(() => [FOLLOW, ...models()]);
  const subagentLevels = createMemo(() => [
    FOLLOW,
    ...levelsOf(state().subagentModel || state().model),
  ]);

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      label="Select Model"
      size="narrow"
      header={<div class="font-bold leading-[--line]">Select Model</div>}
    >
      <Show when={props.open}>
        <div class="min-h-0 space-y-[calc(var(--line)*1.5)] overflow-y-auto p-3">
          <Section title="Main agent">
            <div class="flex flex-wrap gap-2">
              <Menu
                label={state().modelLabel}
                title="Model"
                icon="i-griddy-icons:robot"
                shape="chip"
                place="below"
                search="Search models"
                value={state().model}
                options={models()}
                onSelect={(id) => {
                  void props.store.setModel(id);
                }}
              />
              <Menu
                label={state().thinking}
                title="Effort"
                icon="i-griddy-icons:lightbulb-on"
                shape="chip"
                place="below"
                value={state().thinking}
                options={levels()}
                onSelect={(level) => {
                  void props.store.setThinking(level);
                }}
              />
            </div>
          </Section>

          <Section title="Subagents">
            <div class="flex flex-wrap gap-2">
              <Menu
                title="Subagent model"
                icon="i-griddy-icons:robot"
                shape="chip"
                place="below"
                search="Search models"
                value={state().subagentModel}
                options={subagentModels()}
                onSelect={(id) => {
                  void props.store.setSubagent({ model: id || null });
                }}
              />
              <Menu
                title="Subagent effort"
                icon="i-griddy-icons:lightbulb-on"
                shape="chip"
                place="below"
                value={state().subagentThinking}
                options={subagentLevels()}
                onSelect={(level) => {
                  void props.store.setSubagent({ thinking: level || null });
                }}
              />
            </div>
          </Section>

          <p class="text-sm text-neutral-500">
            Settings apply to this session only.
          </p>
        </div>
      </Show>
    </Modal>
  );
}
