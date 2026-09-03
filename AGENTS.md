# Developer Guide

Pim is an opinionated yet minimal, Bun-native extension pack for [Pi](https://pi.dev/).

`bin/pim.ts` is a Bun launcher that resolves pi's `cli.js` and runs it under Bun, bypassing pi's Node shebang. Other pi extensions still work normally.

Dev setup: `bun link` puts `pim` on PATH; `.pi/settings.json` registers Pim Agent as a project-local pi package, so pi auto-loads it inside this repo. Launching plain `pi` (Node) instead of `pim` trips Pim Agent's Bun runtime guard.

## Layout

Bun workspaces (`packages/*`), no build step — Bun and pi both resolve the TS directly.

| Package | Contents |
| --- | --- |
| `packages/core` | Tools, schemas, `shared/` utilities, `view/` (the `ViewBlock`/`ToolView` contract plus the ANSI and Markdown painters), `session/` (`SessionHost` — one in-process `createAgentSession()`; `EventLog` — a thin reader over pi's session JSONL; `SessionRegistry` — keyed on pi's session UUID), `picker/` (the headless `@`-path and command/skill query: catalog, ranker, worker, `PickerService`), and `attachments/` (`AttachmentStore`). Frontend-agnostic; depends on nothing else in `packages/`. |
| `packages/tui` | Terminal frontend: splash/`_init`, the autocomplete providers that drive `core/picker`, powerline footer, tps, working indicator, `themes/`. |
| `packages/telegram` | Telegram frontend: grammy bot, chat-keyed session map, daemon `Supervisor`. |
| `packages/protocol` | Versioned client/server wire types. Imported by server and web **only** — never by the TUI, and nothing in it may assume a browser. |
| `packages/server` | Transport plus the remote approval policy: `WsGateway` (Bun WebSocket, resume handshake, fanout), `SessionStream`/`SessionProjection` (pi's JSONL → wire events), `ClientConnection` (backpressure), `ApprovalRouter` (the three-tier tool gate), and the `ProbeClient`/`bun run probe` CLI. Workspace-only; never published. |
| `packages/web` | Solid 2 browser client: `ws/` (`WsClient` — socket, resume cursor, reconnect), `session/` (`SessionStore` — the reactive state and the only place an intent becomes a command), the HTML `ViewBlock` painter (`view/`), the streaming `Markdown` component, `ui/` (our own wrappers over platform primitives), `transcript/`, `input/`, `approvals/`, `sessions/`, and `replay/` (the committed session fixture and its generator). Workspace-only; never published. |

The root `package.json` is the published `@aaroncql/pim-agent`: a workspace root that ships `bin/` plus `core`, `tui`, and `telegram`. `protocol` and `server` stay out of `files`; `bun pm pack --dry-run` is the check.

`bun run serve` starts the gateway on `127.0.0.1:4319`; `bun run probe` is the CLI client that validates it (`bun run probe --help`). Session runtime lives in `core/src/session/` rather than in `server` precisely so the published tarball stays `core` + `tui` + `telegram` while Telegram still gets `SessionHost`; `server` holds transport and nothing else. Dependencies are declared once, at the root, because the root is the published manifest; workspace members carry a name and nothing else.

Cross-package imports are ordinary relative paths (`../../core/src/shared/Tools`), never package names — that is what keeps the packed tarball working without workspace resolution.

`bunfig.toml` pins the hoisted linker: Bun switches to the isolated linker when `workspaces` is present, which stops hoisting transitive deps and diverges from how consumers install the package.

## Commands

- `bun run check`: typecheck + test + lint + format. **Run after every change.**
- `bun dev`: `bun link` then launch `pim` from this repo.
- `bun test ./packages --only-failures`: run the agent packages, hiding passing lines. Single test: `bun test packages/core/src/path/to/file.test.ts`.
- `bun run test:web`: the browser package, which needs `--conditions=browser` and so cannot share an invocation with the agent packages (see below). `bun run test` runs both.
- `bun run dev:web` / `bun run build:web`: Vite dev server, and the static `dist/client` bundle `pim-server` will serve.
- `bun run typecheck` / `bun run lint` / `bun run format`: individual steps if you want to isolate.

Inside a running `pim` session, `/reload` re-loads Pim Agent after edits without restarting.

Remote tool approvals are async request/response events, not a modal prompt. `ApprovalRouter` auto-approves tools that declare `effect: { kind: "readOnly" }` and writes whose canonical target stays inside the session cwd; everything else — anything `unbounded`, and anything that declares no `effect` at all — blocks that session's turn until a client answers `approve_tool`. The tier comes from the tool's own declaration in `PimToolDefinition`, never from a name list.

Pickers are always a server-side query, because `@` names a file the *agent* must open and a skill is a capability on the agent's disk (Guiding Decision 8). `PickerService` is per session, keyed on its cwd; ranking never leaves the machine — what crosses the wire is one query and at most `limit` rows. A client caches per query and drops that cache on `picker_invalidate`, which the server pushes when the cwd moves or a tool that is not declared `readOnly` finishes. `RemoteFilePickerSuggestionEngine` is the client half and implements the same `FilePickerSuggestionEngine` the TUI drives in-process.

An upload is not a picker: client bytes must be *transferred into* the server's world before the agent can see them, and a client-local path must never reach the conversation. `AttachmentStore` is that one flow — Telegram's `getFile` and the gateway's `POST /upload` are two adapters over it. Images are inlined as base64 `PromptOptions.images`; everything else is referenced by **server** path.

The web client is **Solid 2, client-only**. Read [notes/solid2-notes.md](./notes/solid2-notes.md) before writing any Solid: v2 removed `createResource`, `batch`, `startTransition`, `on`, `createComputed`, `produce`, `createMutable`, `<Suspense>`, `<ErrorBoundary>` and `<Index>`, which are exactly what muscle memory reaches for. There is no SSR and no server function anywhere — `vite build` emits a static `dist/client` and `pim-server` stays the only backend. No headless component library either (`@ark-ui/*`, `@kobalte/*`, `corvu`): every platform primitive gets our own wrapper in `packages/web/src/ui/`, and feature code never touches `<details>`, `popover` or `<dialog>` directly. `packages/web/src/acceptance.test.ts` enforces all of that.

Markdown is rendered by `streaming-markdown`, chosen by measuring partial input in `packages/web/src/markdown/renderer-choice.test.ts` — it is the only candidate that never repaints text already on screen, because it writes into the DOM append-only instead of re-parsing the whole prefix. Re-run that file before swapping it.

Solid's JSX needs a compiler, which `bun test` has no Vite to provide, so `bunfig.toml` preloads `packages/web/src/test/preload.ts` (the same Oxc compiler). Bun's runtime plugins have no `onResolve`, so the browser builds of `solid-js`/`@solidjs/web` are selected with `--conditions=browser` — which is why the web tests are their own invocation. A test that renders must `import "../test/dom"` first, and `--isolate` keeps those globals from leaking.

The web client's resume cursor is the highest durable `seq` it has painted; a dropped socket re-sends `attach` with `fromSeq` set to it, and everything between that `attach` and its `attached` is discarded so a session switch cannot leak the old session's tail into the new cursor. The trailing in-flight bucket is shaped as an ordinary assistant `message`, which is what lets `toRows` merge live tool calls with durable ones on `callId` with no special case. `list_sessions` is the one command that answers before an `attach`.

Pi's session JSONL is the only event store — no database, no index (`notes/split-architecture-plan.md`, Resolved Decision 2). The wire `seq` is a line's physical ordinal in that file; pi appends and never rewrites, so ordinals are stable and resume is `seq > n`. Read it through `EventLog`, never by hand.

Telegram daemon: `pim --mode telegram --install` writes a user systemd/launchd unit and starts it. From Telegram, `/update` re-runs `bun install` (dev) or bumps the global pi and pim installs to latest (prod), then exits so the supervisor restarts the daemon. `pim --mode telegram --uninstall` tears it down. See `packages/telegram/src/Supervisor.ts`.

## Code Conventions

- Always prefer `type` over `interface`.
- Mark all data-shape fields `readonly` where possible.
- Default to `Bun.*` APIs over Node built-ins (`fs`, `child_process`, etc.), unless Bun does not have a similar API.
- Use comments sparingly, and only to explain why, not what or how.
- Use instance classes for stateful services and lifecycle objects. Avoid static-only classes outside `packages/core/src/shared/`; prefer named functions for stateless module-local helpers.
- Shared utilities that cross module boundaries live in `packages/core/src/shared/` and are exposed as a static-method class rather than a bare function. The filename must match the class name exactly (`Renderer.ts` exports `class Renderer`). Helpers with a single colocated caller stay as bare functions in lowercase files.
- Use relative imports only. Do not use path aliases (`paths` in tsconfig, `imports` in package.json, or `@/`/`#`/`~/` prefixes).
- When committing, check the commit history and use a similar semantic commit message.

## On-demand Docs

Read the topic doc only when its trigger applies to keep context lean.

| When you are… | Read |
| --- | --- |
| touching the Pi API surface (tools, events, ExtensionContext, commands, etc.) | [docs/pi-api.md](./docs/pi-api.md) |
| writing or changing a tool's `execute()` return, error handling, or truncation UX | [docs/tool-output.md](./docs/tool-output.md) |

If a task spans multiple areas, read each relevant doc.
