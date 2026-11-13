import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  untrack,
  type Accessor,
} from "solid-js";

import { Format } from "#core/shared/Format";
import { abbreviateHome, baseName } from "../format";
import type { SessionStore } from "../session/SessionStore";
import type { ConnectionStatus } from "../ws/WsClient";
import { CHIP_BUTTON, CHIP_GROUP, CHIP_SEGMENT } from "../ui/classes";
import { Fitted } from "../ui/Fitted";
import { BranchMenu } from "./BranchMenu";
import { DirectoryModal } from "./DirectoryModal";
import { RepoMenu } from "./RepoMenu";

const GRACE_MS = 1500;

const JOINED = "border-l border-neutral-750";

function changesLabel(count: number, reviewing: boolean, git: boolean): string {
  if (reviewing) {
    return "Back to the conversation";
  }
  if (!git) {
    return "Files and Diffs";
  }
  if (count === 0) {
    return "Files and Diffs, working tree clean";
  }
  return `Files and Diffs, ${Format.count(count, "changed file")}`;
}

export function Topbar(props: {
  readonly store: SessionStore;
  readonly compact: boolean;
  readonly reviewing: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleDiff: () => void;
  readonly onOpenSettings?: () => void;
  readonly graceMs?: number;
}) {
  const [choosing, setChoosing] = createSignal(false);
  const offline = createOffline(
    () => props.store.state.connection,
    () => props.graceMs ?? GRACE_MS
  );
  const paths = (cwd: string): readonly string[] =>
    props.compact ? [baseName(cwd)] : [abbreviateHome(cwd), baseName(cwd)];
  const repos = createRepos(props.store);
  const choosesRepo = (): boolean =>
    (repos.found()?.length ?? 0) > 0 || props.store.state.repo !== "";

  const wake = (): void => {
    if (document.visibilityState === "visible") {
      void props.store.refreshGit();
      repos.refresh();
    }
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
  });
  const changes = (): string =>
    changesLabel(
      props.store.state.dirtyCount,
      props.reviewing,
      !!props.store.state.branch
    );

  return (
    <div class="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-700 px-3">
      <button
        type="button"
        aria-label="Toggle sessions"
        class="flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50"
        onClick={props.onToggleSidebar}
      >
        <span class="i-griddy-icons:sidebar size-5" />
      </button>

      <Show when={props.store.state.cwd}>
        {(cwd) => (
          <button
            type="button"
            class={CHIP_BUTTON}
            aria-label={`Working directory ${abbreviateHome(cwd())}, open another`}
            title={cwd()}
            onClick={() => {
              setChoosing(true);
            }}
          >
            <span class="i-griddy-icons:folder size-4 shrink-0" />
            <Fitted texts={paths(cwd())} />
          </button>
        )}
      </Show>

      <div class="ml-auto" />

      <Show when={offline()}>
        <button
          type="button"
          aria-label="Not connected"
          title="Not connected — reconnecting"
          class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-rose-500/10 px-2 text-sm text-rose-400 hover:bg-rose-500/20"
          onClick={() => props.onOpenSettings?.()}
        >
          <span class="i-griddy-icons:link-off size-4 shrink-0" />
          <Show when={!props.compact}>Not connected</Show>
        </button>
      </Show>

      <div class={CHIP_GROUP}>
        <Show when={choosesRepo()}>
          <RepoMenu
            store={props.store}
            repos={repos.found()}
            onOpen={repos.refresh}
            class="rounded-l-lg"
          />
        </Show>
        <Show when={props.store.state.branch}>
          {(branch) => (
            <BranchMenu
              store={props.store}
              branch={branch()}
              compact={props.compact}
              class={choosesRepo() ? JOINED : "rounded-l-lg"}
            />
          )}
        </Show>
        <button
          type="button"
          aria-pressed={props.reviewing ? "true" : "false"}
          class={`${CHIP_SEGMENT} shrink-0 ${props.store.state.branch || choosesRepo() ? `rounded-r-lg ${JOINED}` : "rounded-lg"}`}
          aria-label={changes()}
          title="Files and Diffs"
          onClick={props.onToggleDiff}
        >
          <span
            class={`i-griddy-icons:file-edit size-4 shrink-0 ${
              props.store.state.dirtyCount > 0 ? "text-amber-400" : ""
            }`}
          />
          <Show when={props.store.state.dirtyCount > 0}>
            <span class="shrink-0 text-amber-400">
              {props.store.state.dirtyCount}
            </span>
          </Show>
        </button>
      </div>

      <DirectoryModal
        open={choosing()}
        store={props.store}
        onClose={() => {
          setChoosing(false);
        }}
      />
    </div>
  );
}

/** True once (re)connecting has lasted `graceMs`. */
function createOffline(
  status: () => ConnectionStatus,
  graceMs: () => number
): () => boolean {
  const [offline, setOffline] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    () => status(),
    (state) => {
      clearTimeout(timer);
      timer = undefined;
      if (state !== "connecting" && state !== "reconnecting") {
        setOffline(false);
        return;
      }
      timer = setTimeout(() => {
        setOffline(true);
      }, graceMs());
    }
  );
  onCleanup(() => {
    clearTimeout(timer);
  });
  return offline;
}

/** Repositories below the attached session's cwd, read again when the cwd moves or a turn that changed files settles; refreshes during a read fold into one more. */
function createRepos(store: SessionStore): {
  readonly found: Accessor<readonly string[] | undefined>;
  readonly refresh: () => void;
} {
  const [found, setFound] = createSignal<readonly string[]>();
  let ticket = 0;
  let pending: number | undefined;
  let again = false;
  const refresh = (): void => {
    const cwd = untrack(() => store.state.cwd);
    if (untrack(() => store.state.sessionId) === "" || cwd === "") {
      return;
    }
    if (pending === ticket) {
      again = true;
      return;
    }
    const mine = ticket;
    pending = mine;
    again = false;
    void store
      .listRepos()
      .then(
        (repos) => {
          if (mine === ticket && untrack(() => store.state.cwd) === cwd) {
            setFound(repos);
          }
        },
        () => undefined
      )
      .then(() => {
        if (mine === ticket) {
          pending = undefined;
          if (again) {
            refresh();
          }
        }
      });
  };
  createEffect(
    () => (store.state.sessionId === "" ? "" : store.state.cwd),
    () => {
      ticket += 1;
      setFound(undefined);
      refresh();
    }
  );
  let read = untrack(() => store.state.filesRevision);
  createEffect(
    () =>
      store.state.agent === "idle" ? store.state.filesRevision : undefined,
    (revision) => {
      if (revision !== undefined && revision !== read) {
        read = revision;
        refresh();
      }
    }
  );
  return { found, refresh };
}
