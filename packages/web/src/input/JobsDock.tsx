import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import { JobLine, type JobLineParts } from "#core/extensions/subagent/JobLine";
import type { JobView } from "#core/extensions/subagent/SubagentJobs";
import { Format } from "#core/shared/Format";
import type { SessionStore } from "../session/SessionStore";
import { Spinner } from "../ui/Spinner";

/** More running jobs than this fold behind a one-line summary. */
const UNFOLDED = 3;

const TICK_MS = 1000;

/** The session's running background subagents; a row opens its child log. */
export function JobsDock(props: { readonly store: SessionStore }) {
  return (
    <Show when={props.store.state.jobs.length > 0}>
      <Dock store={props.store} />
    </Show>
  );
}

function Dock(props: { readonly store: SessionStore }) {
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => {
    setNow(Date.now());
  }, TICK_MS);
  onCleanup(() => {
    clearInterval(clock);
  });
  const [unfolded, setUnfolded] = createSignal(false);
  const jobs = (): readonly JobView[] => props.store.state.jobs;
  const folds = createMemo(() => jobs().length > UNFOLDED);

  return (
    <section
      aria-label="Background subagents"
      class="mb-2 overflow-hidden rounded-lg bg-neutral-900 text-sm text-neutral-350 ring-1 ring-neutral-750"
    >
      <Show when={folds()}>
        <button
          type="button"
          aria-expanded={unfolded() ? "true" : "false"}
          class="flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left hover:bg-neutral-850 hover:text-neutral-100"
          onClick={() => {
            setUnfolded((open) => !open);
          }}
        >
          <Spinner />
          <span class="min-w-0 flex-1 truncate">
            {`${jobs().length} subagents running`}
          </span>
          <span class="shrink-0 tabular-nums text-neutral-400">
            {Format.formatElapsed(now() - jobs()[0]!.startedAt)}
          </span>
          <span
            class={{
              "i-griddy-icons:chevron-right-small-filled size-4 shrink-0 transition-transform": true,
              "rotate-90": unfolded(),
            }}
            aria-hidden="true"
          />
        </button>
      </Show>
      <Show when={!folds() || unfolded()}>
        <ul
          class={{
            "max-h-[40vh] divide-y divide-neutral-750 overflow-y-auto": true,
            "border-t border-neutral-750": folds(),
          }}
        >
          <For each={jobs()} keyed={(job: JobView) => job.id}>
            {(job) => (
              <JobRow
                line={JobLine.parts(job(), now())}
                onOpen={() => {
                  void props.store.watch(job().id);
                }}
              />
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

function JobRow(props: {
  readonly line: JobLineParts;
  readonly onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-haspopup="dialog"
        class="flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left hover:bg-neutral-850 hover:text-neutral-100"
        onClick={() => {
          props.onOpen();
        }}
      >
        <Spinner />
        <span class="min-w-0 flex-1 truncate">
          <span class="font-bold text-neutral-100">{props.line.handle}</span>
          <span class="pr-1ch text-neutral-400">:</span>
          {props.line.stats.join(JobLine.SEPARATOR)}
        </span>
        <span class="shrink-0 tabular-nums text-neutral-400">
          {props.line.elapsed}
        </span>
      </button>
    </li>
  );
}
