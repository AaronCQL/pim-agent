# Developer Guide

Pim is an opinionated yet minimal, Bun-native extension pack for [Pi](https://pi.dev/).

`bin/pim.ts` is a Bun launcher that resolves pi's `cli.js` and runs it under Bun, bypassing pi's Node shebang. Other pi extensions still work normally.

Dev setup: `bun link` puts `pim` on PATH; `.pi/settings.json` registers Pim Agent as a project-local pi package, so pi auto-loads it inside this repo. Launching plain `pi` (Node) instead of `pim` trips Pim Agent's Bun runtime guard.

## Layout

Bun workspaces (`packages/*`), no build step — Bun and pi both resolve the TS directly.

| Package | Contents |
| --- | --- |
| `packages/core` | Tools, schemas, `shared/` utilities, `view/` (the `ViewBlock`/`ToolView` contract plus the ANSI and Markdown painters), and `session/` (`SessionHost` — one in-process `createAgentSession()`; `EventLog` — a thin reader over pi's session JSONL; `SessionRegistry` — keyed on pi's session UUID). Frontend-agnostic; depends on nothing else in `packages/`. |
| `packages/tui` | Terminal frontend: splash/`_init`, file & command pickers, powerline footer, tps, working indicator, `themes/`. |
| `packages/telegram` | Telegram frontend: grammy bot, chat-keyed session map, daemon `Supervisor`. |
| `packages/protocol` | Versioned client/server wire types. Imported by server and web **only** — never by the TUI, and nothing in it may assume a browser. |

The root `package.json` is the published `@aaroncql/pim-agent`: a workspace root that ships `bin/` plus `core`, `tui`, and `telegram`. Session runtime lives in `core/src/session/` rather than a server package precisely so the published tarball stays `core` + `tui` + `telegram` while Telegram still gets `SessionHost`. `protocol` is workspace-only and stays out of `files`. Dependencies are declared once, at the root, because the root is the published manifest; workspace members carry a name and nothing else.

Cross-package imports are ordinary relative paths (`../../core/src/shared/Tools`), never package names — that is what keeps the packed tarball working without workspace resolution.

`bunfig.toml` pins the hoisted linker: Bun switches to the isolated linker when `workspaces` is present, which stops hoisting transitive deps and diverges from how consumers install the package.

## Commands

- `bun run check`: typecheck + test + lint + format. **Run after every change.**
- `bun dev`: `bun link` then launch `pim` from this repo.
- `bun test ./packages --only-failures`: run only previously-failing tests. Single test: `bun test packages/core/src/path/to/file.test.ts`. Keep the `./` — a bare `packages` also matches `vendor/pi/packages/`.
- `bun run typecheck` / `bun run lint` / `bun run format`: individual steps if you want to isolate.

Inside a running `pim` session, `/reload` re-loads Pim Agent after edits without restarting.

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
