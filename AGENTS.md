# Developer Guide

`bin/pim.ts` is a Bun entry point that imports pi's `main()` **in-process** and hands it pim's extensions inline via `MainOptions.extensionFactories`. A vanilla `pi` on the same machine is unaffected, and third-party pi extensions still load alongside pim's. `--mode daemon` routes to `packages/daemon` instead; `--mode web` and `--mode telegram` are its single-surface spellings.

Dev setup: `bun link` puts `pim` on PATH, and `pim` run from anywhere loads this checkout's extensions. Plain `pi` inside this repo is just vanilla pi.

## Layout

Plain layered directories under `packages/*` — no workspaces, no per-directory `package.json`. Cross-package imports use the root `package.json` `imports` aliases (`#core/*` → `packages/core/src/*`, likewise `#tui`, `#telegram`, `#protocol`, `#server`, `#web`, `#daemon`); intra-package imports stay relative. `packages/boundaries.test.ts` enforces which layer may import which.

| Package | Contents |
| --- | --- |
| `packages/core` | Tools, schemas, `shared/`, `view/` (`ViewBlock`/`ToolView` + ANSI/Markdown painters), `session/` (`SessionHost`, `EventLog`, `SessionRegistry`, `AgentRuntime` — one `ModelRuntime` over one `auth.json` per process — `SessionCache`, plus the turn lease one surface takes over a session file it shares with another: `SessionLease` + `WriteMark`), `picker/`, `attachments/`, and the `Supervisor` (systemd/launchd units) with the `DaemonUnit` descriptor. Frontend-agnostic; depends on nothing else in `packages/`. |
| `packages/tui` | Terminal frontend: splash, autocomplete over `core/picker`, footer, themes, and `session-lease` (holds the turn lease, refuses input the browser is mid-turn on, auto-`/sync`s a session the browser moved on). |
| `packages/telegram` | Telegram frontend: grammy bot, chat-keyed sessions under its own session root. Its own product surface — not a third window onto the browser's sessions. |
| `packages/protocol` | Wire types. Server and web **only** — never the TUI; nothing browser-specific. Deliberately unversioned: both halves ship in one install, so skew is a reload nudge (`Reload`, keyed on `pimVersion`), never a refused socket. Keep changes additive — an unknown command answers with an error and an unknown event is ignored. Shipped. |
| `packages/server` | `WsGateway` (resume handshake, fanout, model catalogue), `SessionCatalogue` (session listing, digests, unread state), `SessionProjection` (JSONL → wire events), `SessionStream` (live state, git, context usage), probe CLI. Shipped as source. |
| `packages/web` | Solid 2 browser client: `WsClient`, `SessionStore` (the only place an intent becomes a command), HTML `ViewBlock` painter, `Markdown`, `highlight` (lazy highlight.js, same engine and roles as the TUI). Ships built `dist/client`, not sources. |
| `packages/daemon` | The composition root behind `--mode daemon`: `Surfaces` (`--surfaces web,telegram`), `Daemon` (starts and stops each surface in isolation — one that throws never touches another), `WebSurface`, `TelegramSurface`, and `DaemonInstall` (freezes the unit's argv, supersedes the old per-surface units). The only package that may see both `server` and `telegram`; they stay blind to each other. |

## Checks

`bun run check` is the only way to run the tests. Never `bun test` directly: bare, it silently skips `packages/web`; aimed there, it fails tests that pass in isolation, because happy-dom's globals and pi's module state outlive the file that made them. `check.ts` owns the `--isolate` that fixes it, and is the one place the runners' arguments live.

Narrow with a task name and forward flags to it — `bun run check web`, `bun run check agent --changed`, `bun run check -h`. A green run prints one line; anything else is a failure or a file the formatter rewrote.

## On-demand Docs

| When you are… | Read |
| --- | --- |
| writing code | [docs/style.md](./docs/style.md) |
| touching the Pi API surface (tools, events, ExtensionContext, commands, etc.) | [docs/pi-api.md](./docs/pi-api.md) |
| writing or changing a tool's `execute()` return, error handling, or truncation UX | [docs/tool-output.md](./docs/tool-output.md) |
