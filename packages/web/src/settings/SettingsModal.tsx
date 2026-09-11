import {
  createEffect,
  createSignal,
  Show,
  untrack,
  type Element,
} from "solid-js";

import { Format } from "#core/shared/Format";
import type { SessionStore } from "../session/SessionStore";
import { ACTION, FIELD, QUIET } from "../ui/classes";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import type { Settings } from "./Settings";

const TITLE = "text-xs font-bold uppercase tracking-widest text-neutral-500";

/** Everything this browser decides for itself: which machine it drives, and what it draws. */
export function SettingsModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: SessionStore;
  readonly settings: Settings;
}) {
  const saved = (): string => props.settings.state.serverUrl;
  const [draft, setDraft] = createSignal(untrack(saved));
  createEffect(
    () => props.open,
    (open) => {
      if (open) {
        setDraft(untrack(saved));
      }
    }
  );

  const outdated = (): boolean => props.store.state.connection === "outdated";
  const busy = (): number => props.store.runningIds().length;
  const pending = (): boolean => props.store.update.state.pending;

  // Save, then reload: the socket and every URL are fixed at construction from one address.
  const apply = (url: string): void => {
    props.settings.setServerUrl(url);
    props.store.update.refresh();
  };

  const restart = (): void => {
    if (outdated()) {
      props.store.update.refresh();
      return;
    }
    if (
      busy() > 0 &&
      !window.confirm(
        `Restarting will stop ${Format.count(busy(), "running session")}. Update and restart anyway?`
      )
    ) {
      return;
    }
    void props.store.reload(busy() > 0);
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      label="Settings"
      size="narrow"
      header={<div class="font-bold leading-[--line]">Settings</div>}
    >
      <Show when={props.open}>
        <div class="min-h-0 space-y-[calc(var(--line)*1.5)] overflow-y-auto p-3">
          <Section title="Server">
            <Status store={props.store} settings={props.settings} />
            <form
              class="flex items-center gap-2"
              onSubmit={(event: SubmitEvent) => {
                event.preventDefault();
                apply(draft());
              }}
            >
              <input
                type="text"
                value={draft()}
                spellcheck={false}
                autocapitalize="off"
                autocomplete="off"
                aria-label="Server address"
                placeholder="Enter URL"
                class={FIELD}
                onInput={(event: InputEvent) => {
                  setDraft((event.currentTarget as HTMLInputElement).value);
                }}
              />
              <button
                type="submit"
                class={ACTION}
                disabled={draft().trim() === props.settings.state.serverUrl}
              >
                Connect
              </button>
            </form>
            <Show when={props.settings.state.serverUrl !== ""}>
              <button
                type="button"
                class={QUIET}
                onClick={() => {
                  apply("");
                }}
              >
                Use this device
              </button>
            </Show>
            <Show when={props.settings.insecure()}>
              <p class="text-sm text-amber-400">
                This page is served over HTTPS, so the browser will block a
                plain <code>ws://</code> connection. Use an address this page
                can reach securely.
              </p>
            </Show>
            <p class="text-sm text-neutral-500">
              Changing this reloads the page.
            </p>
          </Section>

          <Section title="App">
            <label class="flex w-fit cursor-pointer items-center gap-2 text-sm">
              <span class="relative flex size-4 shrink-0 items-center justify-center">
                <input
                  type="checkbox"
                  class="peer size-4 appearance-none rounded bg-neutral-850 ring-1 ring-neutral-700 outline-none hover:ring-neutral-600 checked:bg-indigo-400 checked:ring-0 checked:hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                  checked={props.settings.state.hideThinking}
                  onChange={(event: Event) => {
                    props.settings.setHideThinking(
                      (event.currentTarget as HTMLInputElement).checked
                    );
                  }}
                />
                <span
                  class="i-griddy-icons:check pointer-events-none absolute size-3 text-neutral-950 opacity-0 peer-checked:opacity-100"
                  aria-hidden="true"
                />
              </span>
              Hide thinking blocks
            </label>
          </Section>

          <Section title="Updates">
            <button
              type="button"
              aria-label={outdated() ? "Reload page" : "Update & Restart"}
              class={`${ACTION} flex items-center gap-2`}
              disabled={
                pending() ||
                !["open", "outdated"].includes(props.store.state.connection)
              }
              onClick={restart}
            >
              <Show when={pending()}>
                <Spinner />
              </Show>
              {pending()
                ? props.store.update.state.label
                : outdated()
                  ? "Reload page"
                  : "Update & Restart"}
            </button>
            <p class="text-sm text-neutral-500">
              {busy() > 0
                ? `Installs all updates and refreshes your browser, stopping ${Format.count(busy(), "running session")}.`
                : "Installs all updates and refreshes your browser."}
            </p>
          </Section>
        </div>
      </Show>
    </Modal>
  );
}

function Status(props: {
  readonly store: SessionStore;
  readonly settings: Settings;
}) {
  const host = (): string =>
    URL.parse(props.settings.gateway())?.host ?? props.settings.gateway();
  const state = (): { readonly tone: string; readonly text: string } => {
    switch (props.store.state.connection) {
      case "open":
        return { tone: "text-emerald-400", text: `Connected to ${host()}` };
      case "outdated":
        return {
          tone: "text-slate-500",
          text: "This tab is outdated — reload it",
        };
      case "closed":
        return { tone: "text-neutral-500", text: "Not connected" };
      default:
        return { tone: "text-amber-400", text: `Connecting to ${host()}…` };
    }
  };

  return (
    <p class="flex items-center gap-1.5 text-sm text-neutral-350">
      <span
        class={`i-griddy-icons:server size-4 shrink-0 ${state().tone}`}
        aria-hidden="true"
      />
      <span class="min-w-0 truncate">{state().text}</span>
    </p>
  );
}

function Section(props: {
  readonly title: string;
  readonly children: Element;
}) {
  return (
    <section class="space-y-2">
      <h2 class={TITLE}>{props.title}</h2>
      {props.children}
    </section>
  );
}
