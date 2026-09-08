# Pi API

## Upstream reference

`node_modules/@earendil-works/pi-coding-agent/docs/` is the reference for the version pim actually runs — `extensions.md` primarily, plus `compaction.md`, `custom-provider.md`, `keybindings.md`, `models.md`, `packages.md`, `sdk.md`, `session-format.md`, `settings.md`, `skills.md`, `themes.md`, `tui.md`. When the prose is ambiguous, read `dist/` — unminified per-file ESM with `.d.ts` and source maps.

## Cheatsheet

**Extension shape**: TS module, default export `(pi: ExtensionAPI) => void | Promise<void>` (async factories finish before `session_start`). In pim they are inline factories listed in `bin/pim.ts`, living in `packages/{core,tui}/src/extensions/<name>/index.ts`.

**Imports**: `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`, `Theme`, `AgentToolResult`, event types), `@earendil-works/pi-tui` (`Component`, `Container`, `visibleWidth`, `wrapTextWithAnsi`), `@earendil-works/pi-ai` (`StringEnum`, `validateToolArguments`), `typebox`.

**`pi.*`**: `on`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `registerMessageRenderer`, `appendEntry` (session-persistent state that survives compaction), `sendMessage`/`sendUserMessage`, `setModel`, `getActiveTools`/`setActiveTools`, `events`, `exec`.

**Events**: `session_start`, `session_before_fork`/`_before_tree`/`_tree`, `session_before_compact`/`_compact`, `session_before_switch`, `session_shutdown`, `before_agent_start`, `agent_start`/`_end`, `turn_start`/`_end`, `message_start`/`_update`/`_end`, `tool_call` (return `{ block: true, reason }` to veto), `tool_result`, `tool_execution_start`/`_update`/`_end`, `before_provider_request`, `after_provider_response`, `user_bash`, `input`, `model_select`, `thinking_level_select`, `resources_discover`.

**`ctx` (ExtensionContext)**: `ui` (`notify`, `confirm`, `select`, `input`, `setStatus`, `setWidget`, `setFooter`, `setWorkingIndicator`, `setWorkingMessage`, `addAutocompleteProvider`, `theme`, `custom`), `hasUI`, `cwd`, `signal`, `sessionManager`, `modelRegistry`/`model`, `isIdle()`/`abort()`/`hasPendingMessages()`, `shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()`. Command ctx adds `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload` — session replacement has footguns, read the upstream doc first.

**Tool def**: `{ name, label, description, parameters: TypeBox, renderShell: 'self', executionMode, async execute(toolCallId, params, signal, onUpdate, ctx) }` returning `{ content: [{type:'text', text}], details: {} }`. Optional `renderCall`/`renderResult`, `promptSnippet`, `remote`. `renderShell: 'self'` (standard in pim) means the tool renders itself. `executionMode: 'sequential'` serialises the tool (bash, edit, write, todo); `'parallel'` allows concurrent calls (glob, grep, read, subagent, web-fetch, web-search).

**Registering tools**: `Tools.register(pi, def)`, or `Tools.wrap(def)` for `customTools`. Never call `pi.registerTool` directly — the wrapper rewrites pi's raw validator errors into actionable messages and tightens coercions that hide bugs.

**Hosting a session**: `createAgentSession()` registers tools, but only `session.bindExtensions({ mode, onError })` emits `session_start` — extensions that initialize there (MCP adapters) stay dead without it, and `session.reload()` re-emits it only when a binding is set. Disposal is symmetric: emit `session_shutdown` via `session.extensionRunner.emit(...)` before `session.dispose()`.

**Tool approvals**: pim has none — every call runs unattended, in the TUI and over the wire alike. Pi has no approval API either: `Agent.beforeToolCall` (reachable as `agentSession.agent.beforeToolCall`) is a public mutable hook awaited before each call, where `{ block: true, reason }` turns the call into an error result and resolving late defers the decision indefinitely. `AgentSession` installs its own bridge there in its constructor — wrap it, don't replace it. Anything that gates a call belongs at the server, not in a client dialog.

**Autocomplete providers**: `ctx.ui.addAutocompleteProvider(factory)` in `session_start`. The factory receives the current provider and returns a decorator over `getSuggestions`, `applyCompletion`, `shouldTriggerFileCompletion`. See `file-picker` / `command-picker` in `packages/tui/src/extensions/`.

## Shared utilities (`packages/core/src/shared/`)

`Tools` (register/wrap) · `Renderer` (tool-call titles, error results, prefixed blocks) · `DiffView`/`DiffRenderer`/`DiffLines` · `EditMatcher` (multi-strategy match for edit) · `FsErrors` (`statOrThrow` with "did you mean") · `Fs` (`readJsonOrEmpty`, `writeAtomic`) · `Paths` · `PimSettings` · `OutputBudget` (32KB cap, 2000-char lines) · `FileScanner` / `GlobExclusions` · `McpClient` · `FuzzyMatcher` / `Levenshtein` / `Lines`.
