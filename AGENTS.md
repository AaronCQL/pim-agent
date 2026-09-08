# Developer Guide

Pim is an opinionated, Bun-native distribution of [Pi](https://pi.dev/).

`bin/pim.ts` is a Bun entry point that imports pi's `main()` **in-process** and hands it pim's extensions inline via `MainOptions.extensionFactories`. A vanilla `pi` on the same machine is unaffected, and third-party pi extensions still load alongside pim's.

Dev setup: `bun link` puts `pim` on PATH, and `pim` run from anywhere loads this checkout's extensions. Plain `pi` inside this repo is just vanilla pi.

## Layout

Plain layered directories under `packages/*` — no workspaces, no per-directory `package.json`. Cross-package imports use the root `package.json` `imports` aliases (`#core/*` → `packages/core/src/*`, likewise `#tui`, `#telegram`, `#protocol`, `#server`, `#web`); intra-package imports stay relative. `packages/boundaries.test.ts` enforces which layer may import which.

| Package | Contents |
| --- | --- |
| `packages/core` | Tools, schemas, `shared/`, `view/` (`ViewBlock`/`ToolView` + ANSI/Markdown painters), `session/` (`SessionHost`, `EventLog`, `SessionRegistry`), `picker/`, `attachments/`, and the daemon `Supervisor` (systemd/launchd units, one per `--mode`). Frontend-agnostic; depends on nothing else in `packages/`. |
| `packages/tui` | Terminal frontend: splash, autocomplete over `core/picker`, footer, themes. |
| `packages/telegram` | Telegram frontend: grammy bot, chat-keyed sessions, its `Supervisor` unit descriptor. |
| `packages/protocol` | Versioned wire types. Server and web **only** — never the TUI; nothing browser-specific. Shipped. |
| `packages/server` | `WsGateway` (resume handshake, fanout, model catalogue), `SessionCatalogue` (session listing, digests, unread state), `SessionProjection` (JSONL → wire events), `SessionStream` (live state, git, context usage), probe CLI. Shipped as source. |
| `packages/web` | Solid 2 browser client: `WsClient`, `SessionStore` (the only place an intent becomes a command), HTML `ViewBlock` painter, `Markdown`, `highlight` (lazy highlight.js, same engine and roles as the TUI). Ships built `dist/client`, not sources. |

## On-demand Docs

| When you are… | Read |
| --- | --- |
| writing code | [docs/style.md](./docs/style.md) |
| touching the Pi API surface (tools, events, ExtensionContext, commands, etc.) | [docs/pi-api.md](./docs/pi-api.md) |
| writing or changing a tool's `execute()` return, error handling, or truncation UX | [docs/tool-output.md](./docs/tool-output.md) |
