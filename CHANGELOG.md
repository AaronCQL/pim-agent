# Changelog

## v0.9.0

### Breaking Changes

- Renamed the npm package from `@aaroncql/pim-agent` to `pim-agent`. `pim update` cannot cross a rename, so install it once by hand: `bun install -g pim-agent`, then `bun remove -g @aaroncql/pim-agent` (955ecf2)
- Web and Telegram now run under one daemon unit instead of one unit each. Re-run `pim --mode daemon --install` after upgrading; the old per-surface units are superseded and the arguments they were frozen with are carried over (#22)
- The todo tool is off by default; turn it back on under `/pim` (dc96ca3)

### Features

- A browser frontend: live transcript, session list, file and command pickers, uploads, tool approvals, syntax highlighting and a mobile-first layout, served by a new websocket gateway (#16)
- Any session can be continued from either the terminal or the browser, with a turn lease deciding who holds the turn and a `/sync` when the other surface moved on (#21)
- The model can see images — pasted, uploaded or attached by path (#20)
- One daemon process serves every surface, chosen with `--surfaces web,telegram`; a surface that fails to start never takes another down (#22)
- Subagents run with pim's tools instead of pi's built-ins, and their transcripts are kept and readable rather than discarded (40009c1, c9308ef, 60c56fe)
- Supervised `pim update` from the TUI and the browser: it rebuilds the web client, restarts the daemon, and reports what it skipped (a2a4311, 6e4689d)
- A `send_file` tool that hands a file to the browser (4cd6d42)
- V4A patches for Opus and Fable 5+ (ed1bdc4)

### Improvements

- Pim is a distribution of pi loaded in-process: it resolves pi from its own dependency instead of probing PATH, so one copy of pi backs the CLI and the extensions (7a87006, caa458c)
- Split into layered packages — `core`, `tui`, `telegram`, `protocol`, `server`, `web`, `daemon` — with import boundaries enforced by a test (#16, 18b45e5)
- Bump `pi-coding-agent` to 0.85.1 (d633d83)

### Bug Fixes

- Hash subagent call ids into log paths so a long id cannot overflow the filename (5af991c)
- Name a session by its opening message rather than by its first 64KB or the draft in the composer (3030513, 7b1bf65)
- Time a turn by the session that is running, not by the tab that last looked at it (8c0400f)
- Keep pim's `--theme` flag off pi's subcommands (b19105e)
- Report a failed turn setup to the Telegram chat instead of dropping it (2ad4ae5)
- Default `ky` to no retries, so a failing request fails once (3e60104)

## v0.8.0

### Features

- Fall back across keyless web search providers, adding Firecrawl and DuckDuckGo behind Exa, with a disk-backed circuit breaker for quota rejections and the serving provider surfaced in the TUI, tool details, and Telegram (#15)

### Bug Fixes

- Skip unreadable entries during a grep scan instead of aborting the whole search (675711b)

## v0.7.0

### Features

- Expand a bare directory passed to grep's `glob` or the glob tool's `pattern` into a recursive glob instead of returning zero matches (3501231)

### Bug Fixes

- Update the pi-managed pim package during Telegram `/update`, so pi no longer loads a stale extension copy from its own package dir (4351a55)

## v0.6.1

### Bug Fixes

- Bind extensions in Telegram sessions so `session_start` reaches them and MCP initializes, and emit `session_shutdown` before disposing agents (#13)
- Break between adjacent todo and tool status entries in Telegram status messages (52559a2)
- Guard the Telegram subagent label update against empty error details (51efbcd)

### Improvements

- Bump `pi-coding-agent` to 0.82.0 (9164756)

## v0.6.0

### Features

- Update pi alongside pim in prod Telegram `/update` and report its version (1b7e3e4)

### Improvements

- Bump `pi-coding-agent` to 0.80.10 and migrate to the ModelRuntime API (54d7046)

## v0.5.0

### Features

- Render Telegram status narration as Markdown with message length caps (cafa871)

### Bug Fixes

- Require double tildes for Telegram strikethrough formatting (#12)

## v0.4.0

### Features

- Render Telegram replies and live status as Bot API 10.1 rich messages (b1afcb9)
- Reuse Exa MCP sessions and throttle free-tier web searches (60eef60)

### Improvements

- Document Telegram rich text formatting (1953b3c)

## v0.3.0

### Features

- Run file picker suggestion ranking in a worker thread to improve performance for large number of files (cebda6d)
- Scope file picker ranking to directory children and add literal fast path to improve performance for large number of files (b2d388d)
- Add a literal fast path to improve `grep` performance for large number of files (a50fee3)
- Add repo-aware file enumeration with accurate nested Git ignore handling (131483e)
- List directories in the file picker and avoid adding a trailing space on tab completion (c47deff)

### Bug Fixes

- Respect excluded edit tools when using `apply_patch` (556f991)

### Improvements

- Bump dependencies (4920aaf)
- Add edit micro benchmark and results (13541c1, 500f749)
- Add README badges (0baf591)

## v0.2.0

### Features

- Add the `apply_patch` V4A patch tool for GPT/Codex models (d0b559d)
- Show `apply_patch` operations and diff stats in Telegram status updates (5026999)
- Render `read` output with muted line numbers (0ff35ab)

### Bug Fixes

- Format `glob` targets in `grep` result titles (802026c)
- Use a hardcoded `settings.json` for the Terminal Bench 2 adapter (01f5d7f)

### Improvements

- Add the release skill (c0d9b1e)
- Refine tool descriptions (a038607)
- Add the release workflow (00150cd)
- Document `apply_patch` usage (96f52cf)
- Update Telegram feature documentation (ac2126b)
- Refresh the demo asset (76ecdbc)
- Add `Levenshtein` tests (e1928f3)
- Refresh project and benchmark READMEs (b93294c)

## v0.1.0

### Features

- Initial release
