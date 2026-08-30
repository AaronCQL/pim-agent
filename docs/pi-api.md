# Pi API

Read this when touching the pi API surface — registering tools/commands/providers/renderers, wiring into pi events, or using ExtensionContext.

## Vendor docs

Shallow clone of [pi](https://github.com/earendil-works/pi) at `vendor/pi/` (gitignored).

- Bootstrap: `git clone --depth 1 https://github.com/earendil-works/pi.git vendor/pi`
- Refresh: `git -C vendor/pi pull`
- Clone tracks `main`; if behavior diverges from the installed version, check `node_modules/@earendil-works/pi-coding-agent/package.json` and `git -C vendor/pi checkout <tag>`.

Primary ref: `vendor/pi/packages/coding-agent/docs/extensions.md` (~2600 lines).

Sibling docs: `compaction.md`, `custom-provider.md`, `keybindings.md`, `models.md`, `packages.md`, `sdk.md`, `session-format.md`, `settings.md`, `skills.md`, `themes.md`, `tui.md`. Source under `vendor/pi/packages/coding-agent/src/` is canonical.

## Cheatsheet

**Extension shape**: TS module, default export `(pi: ExtensionAPI) => void | Promise<void>` (async factories finish before `session_start`). Auto-discovered from `~/.pi/agent/extensions/*.ts`, `.pi/extensions/*.ts`, or `*/index.ts` subdirs of either. In this repo: `packages/{core,tui}/src/extensions/<name>/index.ts` (helpers colocated), `packages/tui/src/themes/`, wired via the `pi.extensions` / `pi.themes` fields of `package.json`.

**Imports**: `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`, `Theme`, `AgentToolResult`, `ToolRenderResultOptions`, event types), `@earendil-works/pi-tui` (`Component`, `Container`, `visibleWidth`, `wrapTextWithAnsi`), `@earendil-works/pi-ai` (`StringEnum`, `validateToolArguments`), `typebox` (`Type`, `Static`). Node built-ins + npm deps work.

**`pi.*`**: `on` (subscribe to events), `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `registerMessageRenderer`, `appendEntry` (session-persistent state for compaction survival), `sendMessage`/`sendUserMessage`, `setModel`, `getActiveTools`/`setActiveTools`, `events`, `exec`.

**Hosting a session**: `createAgentSession()` loads extensions and registers their tools, but only `session.bindExtensions({ mode, onError })` emits `session_start` — extensions that initialize there (MCP adapters) stay dead without it. Pass `onError` (or another binding): `session.reload()` re-emits `session_start` only when a binding is set. Disposal is symmetric — emit `session_shutdown` via `session.extensionRunner.emit(...)` before `session.dispose()`. See `Session.buildAgent`/`disposeAgent` in `packages/telegram/src/`.

**Events**: `session_start`, `session_before_fork`/`session_before_tree`/`session_tree`, `session_before_compact`/`session_compact`, `session_before_switch`, `session_shutdown`, `before_agent_start`, `agent_start`/`agent_end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_call` (return `{ block: true, reason }` to veto), `tool_result`, `tool_execution_start`/`update`/`end`, `before_provider_request`, `after_provider_response`, `user_bash`, `input`, `model_select`, `thinking_level_select`, `resources_discover`.

**`ctx` (ExtensionContext)**: `ui` (`notify`, `confirm`, `select`, `input`, `setStatus`, `setWidget`, `setFooter`, `setWorkingIndicator`, `setWorkingMessage`, `addAutocompleteProvider`, `theme`, `custom`), `hasUI`, `cwd`, `signal`, `sessionManager` (`getBranch()`, `getEntries()`), `modelRegistry`/`model`, `isIdle()`/`abort()`/`hasPendingMessages()`, `shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()`. Command ctx adds `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload` - session replacement has footguns, read the vendor doc first.

**Tool def**: `{ name, label, description, parameters: TypeBox, renderShell: 'self', executionMode: 'sequential' | 'parallel', async execute(toolCallId, params, signal, onUpdate, ctx) { return { content: [{type:'text', text}], details: {} } } }`. Optional `renderCall`/`renderResult`, `promptSnippet`, `remote` for off-process. `renderShell: 'self'` means the tool controls its own rendering (standard in pim). `executionMode: 'sequential'` serialises this tool (bash, edit, write, todo); `parallel` allows concurrent calls (glob, grep, read, subagent, web-fetch, web-search).

**Registering tools**: `Tools.register(pi, def)` for extensions, `Tools.wrap(def)` for `customTools` (see `packages/core/src/shared/Tools.ts`). Never call `pi.registerTool` directly — the wrapper rewrites pi's raw validator errors into actionable messages and tightens a few coercions that hide bugs.

**Autocomplete providers**: Register via `ctx.ui.addAutocompleteProvider(factory)` in `session_start`. The factory receives the current provider and returns a decorator wrapping `getSuggestions`, `applyCompletion`, and `shouldTriggerFileCompletion`. See `file-picker` (`@`-triggered path completion) and `command-picker` (`/`-triggered command completion) in `packages/tui/src/extensions/`.

**Commands**: `pi.registerCommand(name, { description, handler })`. Handler receives `(args, ctx: CommandExtensionContext)`. See `/powerline` (footer), `/tps` (tps), `/clear` (\_init).

**Shared utilities** (all in `packages/core/src/shared/`):

- `Tools` — `register(pi, def)` / `wrap(def)`. Validation error rewriting, enum coercion, unknown-key detection.
- `Renderer` — `renderToolCallTitle`, `renderStatefulToolCallTitle`, `renderBorderedResult`, `makePrefixedBlock`. Standard rendering primitives.
- `DiffView` / `DiffRenderer` / `DiffLines` — Diff computation, syntax-highlighted rendering, stats formatting. Used by edit and write.
- `EditMatcher` — Multi-strategy string matching for the edit tool (simple, line-trimmed, whitespace-normalized, indentation-flexible, escape-normalized, unicode-normalized, block-anchor, context-aware).
- `FsErrors` — `statOrThrow(path)` with "did you mean" sibling suggestions for ENOENT.
- `Fs` — `readJsonOrEmpty`, `writeAtomic` (atomic rename with mode preservation).
- `Paths` — `resolve`, `displayRelative`, `expandHome`, `titleOr`.
- `PimSettings` — `get`/`set` for persistent user toggles (`tps`, `powerline`).
- `OutputBudget` — 32KB byte cap, 2000-char line truncation, `applyByteCap` for item lists.
- `FileScanner` — Recursive file scanning with gitignore + exclusion support.
- `GitignoreFilter` — Reads `.gitignore` chains from root to nearest `.git` directory.
- `GlobExclusions` — Compiles exclude globs for `FileScanner`.
- `McpClient` — MCP JSON-RPC/SSE client for external tool services.
- `FuzzyMatcher` / `Levenshtein` / `Lines` — Fuzzy matching, string distance, line utilities.
