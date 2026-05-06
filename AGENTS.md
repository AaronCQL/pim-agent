# Developer Guide

Pim is a Bun-native, opinionated extension pack for [Pi Agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

`bin/pim.ts` is a Bun launcher that resolves pi's `cli.js` and runs it under Bun, bypassing pi's Node shebang. Other pi extensions still work normally.

Dev setup: `bun link` puts `pim` on PATH; `.pi/settings.json` registers Pim as a project-local pi package, so pi auto-loads it inside this repo. Launching plain `pi` (Node) here trips Pim's Bun runtime guard — use `pim`.

## Code Conventions

- Always prefer using `type` over `interface`
- Mark all data-shape fields `readonly` where possible
- Default to `Bun.*` APIs over Node built-ins (`fs`, `child_process`, etc.)
- Use comments sparingly, and only to explain why, not what or how
- **IMPORTANT**: Always run `bun run check` after finishing a change

## Pi Extension API

Shallow clone of [pi-mono](https://github.com/badlogic/pi-mono) at `vendor/pi-mono/` (gitignored). Bootstrap: `git clone --depth 1 https://github.com/badlogic/pi-mono.git vendor/pi-mono`. Refresh: `git -C vendor/pi-mono pull`. Clone tracks `main`; if behavior diverges, check installed version in `node_modules/@mariozechner/pi-coding-agent/package.json` and `git -C vendor/pi-mono checkout <tag>`.

Primary ref: `vendor/pi-mono/packages/coding-agent/docs/extensions.md` (~2600 lines). Don't read whole — `grep -n '^##\|^###' …/extensions.md` for the section index, then `Read` with offset/limit. Sibling docs: `compaction.md`, `custom-provider.md`, `keybindings.md`, `models.md`, `packages.md`, `sdk.md`, `session-format.md`, `settings.md`, `skills.md`, `themes.md`, `tui.md`. Source under `vendor/pi-mono/packages/coding-agent/src/` is canonical.

### Cheatsheet

**Extension shape** — TS module, default export `(pi: ExtensionAPI) => void | Promise<void>` (async factories finish before `session_start`). Auto-discovered from `~/.pi/agent/extensions/*.ts`, `.pi/extensions/*.ts`, or `*/index.ts` subdirs of either. In this repo: `src/extensions/<name>/index.ts` (helpers colocated), `src/prompts/`, `src/themes/`, all wired via `.pi/settings.json` and the `pi` field of `package.json`.

**Imports** — `@mariozechner/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`, event types), `typebox` (tool params), `@mariozechner/pi-ai` (`StringEnum`), `@mariozechner/pi-tui` (custom rendering). Node built-ins + npm deps work.

**`pi.*`** — `on`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `registerMessageRenderer`, `appendEntry` (session-persistent state), `sendMessage`/`sendUserMessage`, `setModel`, `getActiveTools`/`setActiveTools`, `events`, `exec`.

**Events** — `session_start`, `session_before_compact`/`session_compact`, `session_shutdown`, `before_agent_start`, `agent_start`/`agent_end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_call` (return `{ block: true, reason }` to veto), `tool_result`, `tool_execution_start`/`update`/`end`, `before_provider_request`, `after_provider_response`, `user_bash`, `input`, `model_select`, `resources_discover`.

**`ctx` (ExtensionContext)** — `ui` (`notify`, `confirm`, `select`, `input`, `setStatus`, `setWidget`, `custom`), `hasUI`, `cwd`, `signal`, `sessionManager`, `modelRegistry`/`model`, `isIdle()`/`abort()`/`hasPendingMessages()`, `shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()`. Command ctx adds `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload` — session replacement has footguns, read the doc first.

**Tool def** — `{ name, label, description, parameters: TypeBox, async execute(toolCallId, params, signal, onUpdate, ctx) { return { content: [{type:'text', text}], details: {} } } }`. Optional `renderCall`/`renderResult`, `remote` for off-process.
