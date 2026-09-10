# Developer Guide

Pim is an opinionated, Bun-native distribution of [Pi](https://pi.dev/).

`bin/pim.ts` is a Bun entry point that imports pi's `main()` **in-process** and hands it pim's extensions inline via `MainOptions.extensionFactories`. A vanilla `pi` on the same machine is unaffected, and third-party pi extensions still load alongside pim's. `--mode daemon` routes to `packages/daemon` instead; `--mode web` and `--mode telegram` are its single-surface spellings.

Dev setup: `bun link` puts `pim` on PATH, and `pim` run from anywhere loads this checkout's extensions. Plain `pi` inside this repo is just vanilla pi.

## Layout

Plain layered directories under `packages/*` — no workspaces, no per-directory `package.json`. Cross-package imports use the root `package.json` `imports` aliases (`#core/*` → `packages/core/src/*`, likewise `#tui`, `#telegram`, `#protocol`, `#server`, `#web`, `#daemon`); intra-package imports stay relative. `packages/boundaries.test.ts` enforces which layer may import which.

| Package | Contents |
| --- | --- |
| `packages/core` | Tools, schemas, `shared/`, `view/` (`ViewBlock`/`ToolView` + ANSI/Markdown painters), `session/` (`SessionHost`, `EventLog`, `SessionRegistry`, `AgentRuntime` — one `ModelRuntime` over one `auth.json` per process — `SessionCache`, plus the turn lease one surface takes over a session file it shares with another: `SessionLease` + `WriteMark`), `picker/`, `attachments/`, and the `Supervisor` (systemd/launchd units) with the `DaemonUnit` descriptor. Frontend-agnostic; depends on nothing else in `packages/`. |
| `packages/tui` | Terminal frontend: splash, autocomplete over `core/picker`, footer, themes, and `session-lease` (holds the turn lease, refuses input the browser is mid-turn on, auto-`/sync`s a session the browser moved on). |
| `packages/telegram` | Telegram frontend: grammy bot, chat-keyed sessions under its own session root. Its own product surface — not a third window onto the browser's sessions. |
| `packages/protocol` | Versioned wire types. Server and web **only** — never the TUI; nothing browser-specific. Shipped. |
| `packages/server` | `WsGateway` (resume handshake, fanout, model catalogue), `SessionCatalogue` (session listing, digests, unread state), `SessionProjection` (JSONL → wire events), `SessionStream` (live state, git, context usage), probe CLI. Shipped as source. |
| `packages/web` | Solid 2 browser client: `WsClient`, `SessionStore` (the only place an intent becomes a command), HTML `ViewBlock` painter, `Markdown`, `highlight` (lazy highlight.js, same engine and roles as the TUI). Ships built `dist/client`, not sources. |
| `packages/daemon` | The composition root behind `--mode daemon`: `Surfaces` (`--surfaces web,telegram`), `Daemon` (starts and stops each surface in isolation — one that throws never touches another), `WebSurface`, `TelegramSurface`, and `DaemonInstall` (freezes the unit's argv, supersedes the old per-surface units). The only package that may see both `server` and `telegram`; they stay blind to each other. |

## On-demand Docs

| When you are… | Read |
| --- | --- |
| writing code | [docs/style.md](./docs/style.md) |
| touching the Pi API surface (tools, events, ExtensionContext, commands, etc.) | [docs/pi-api.md](./docs/pi-api.md) |
| writing or changing a tool's `execute()` return, error handling, or truncation UX | [docs/tool-output.md](./docs/tool-output.md) |
