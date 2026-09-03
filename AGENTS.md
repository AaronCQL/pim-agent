# Developer Guide

Pim is an opinionated, Bun-native distribution of [Pi](https://pi.dev/).

`bin/pim.ts` is a Bun entry point that imports pi's `main()` **in-process** and hands it pim's extensions inline via `MainOptions.extensionFactories`. A vanilla `pi` on the same machine is unaffected, and third-party pi extensions still load alongside pim's.

Dev setup: `bun link` puts `pim` on PATH, and `pim` run from anywhere loads this checkout's extensions. Plain `pi` inside this repo is just vanilla pi.

## Layout

Workspaces using Bun (`packages/*`).

| Package | Contents |
| --- | --- |
| `packages/core` | Tools, schemas, `shared/`, `view/` (`ViewBlock`/`ToolView` + ANSI/Markdown painters), `session/` (`SessionHost`, `EventLog`, `SessionRegistry`), `picker/`, `attachments/`. Frontend-agnostic; depends on nothing else in `packages/`. |
| `packages/tui` | Terminal frontend: splash, autocomplete over `core/picker`, footer, themes. |
| `packages/telegram` | Telegram frontend: grammy bot, chat-keyed sessions, daemon `Supervisor`. |
| `packages/protocol` | Versioned wire types. Server and web **only** — never the TUI; nothing browser-specific. Shipped. |
| `packages/server` | `WsGateway` (resume handshake, fanout), `SessionProjection` (JSONL → wire events), `ApprovalRouter` (three-tier tool gate), probe CLI. Shipped as source. |
| `packages/web` | Solid 2 browser client: `WsClient`, `SessionStore` (the only place an intent becomes a command), HTML `ViewBlock` painter, `Markdown`. Ships built `dist/client`, not sources. |

## On-demand Docs

| When you are… | Read |
| --- | --- |
| writing code | [docs/style.md](./docs/style.md) |
| touching the Pi API surface (tools, events, ExtensionContext, commands, etc.) | [docs/pi-api.md](./docs/pi-api.md) |
| writing or changing a tool's `execute()` return, error handling, or truncation UX | [docs/tool-output.md](./docs/tool-output.md) |
