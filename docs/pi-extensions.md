# Pi Extension API

Read this when adding or modifying anything under `src/extensions/`, registering a tool/command/provider/renderer, or wiring into a pi event.

## Vendor docs

Shallow clone of [pi](https://github.com/earendil-works/pi) at `vendor/pi/` (gitignored).

- Bootstrap: `git clone --depth 1 https://github.com/earendil-works/pi.git vendor/pi`
- Refresh: `git -C vendor/pi pull`
- Clone tracks `main`; if behavior diverges from the installed version, check `node_modules/@earendil-works/pi-coding-agent/package.json` and `git -C vendor/pi checkout <tag>`.

Primary ref: `vendor/pi/packages/coding-agent/docs/extensions.md` (~2600 lines). Don't read whole - `grep -n '^##\|^###' …/extensions.md` for the section index, then `Read` with offset/limit.

Sibling docs: `compaction.md`, `custom-provider.md`, `keybindings.md`, `models.md`, `packages.md`, `sdk.md`, `session-format.md`, `settings.md`, `skills.md`, `themes.md`, `tui.md`. Source under `vendor/pi/packages/coding-agent/src/` is canonical.

## Cheatsheet

**Extension shape**: TS module, default export `(pi: ExtensionAPI) => void | Promise<void>` (async factories finish before `session_start`). Auto-discovered from `~/.pi/agent/extensions/*.ts`, `.pi/extensions/*.ts`, or `*/index.ts` subdirs of either. In this repo: `src/extensions/<name>/index.ts` (helpers colocated), `src/prompts/`, `src/themes/`, all wired via `.pi/settings.json` and the `pi` field of `package.json`.

**Imports**: `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`, event types), `typebox` (tool params), `@earendil-works/pi-ai` (`StringEnum`), `@earendil-works/pi-tui` (custom rendering). Node built-ins + npm deps work.

**`pi.*`**: `on`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `registerMessageRenderer`, `appendEntry` (session-persistent state), `sendMessage`/`sendUserMessage`, `setModel`, `getActiveTools`/`setActiveTools`, `events`, `exec`.

**Events**: `session_start`, `session_before_compact`/`session_compact`, `session_shutdown`, `before_agent_start`, `agent_start`/`agent_end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_call` (return `{ block: true, reason }` to veto), `tool_result`, `tool_execution_start`/`update`/`end`, `before_provider_request`, `after_provider_response`, `user_bash`, `input`, `model_select`, `resources_discover`.

**`ctx` (ExtensionContext)**: `ui` (`notify`, `confirm`, `select`, `input`, `setStatus`, `setWidget`, `custom`), `hasUI`, `cwd`, `signal`, `sessionManager`, `modelRegistry`/`model`, `isIdle()`/`abort()`/`hasPendingMessages()`, `shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()`. Command ctx adds `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload` - session replacement has footguns, read the doc first.

**Tool def**: `{ name, label, description, parameters: TypeBox, async execute(toolCallId, params, signal, onUpdate, ctx) { return { content: [{type:'text', text}], details: {} } } }`. Optional `renderCall`/`renderResult`, `remote` for off-process.

**Register tools through `Tools` (from `src/shared/Tools.ts`), not `pi.registerTool` directly.** `Tools.register(pi, def)` for extensions, `Tools.wrap(def)` for `customTools`. The wrapper intercepts pi's raw validator errors and rewrites them into actionable messages (anyOf collapsing, enum value listing, "did you mean" hints for unknown keys), unwraps quoted enum values from weak models, and blocks the two coercions that hide bugs (`null` → primitive, float-string → integer truncation).
