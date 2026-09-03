<!-- omit in toc -->
# PIM - Pi IMproved

[![npm version](https://img.shields.io/npm/v/pim-agent?style=flat-square)](https://www.npmjs.com/package/pim-agent)
[![npm downloads](https://img.shields.io/npm/dm/pim-agent?style=flat-square)](https://www.npmjs.com/package/pim-agent)
[![license](https://img.shields.io/npm/l/pim-agent?style=flat-square)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun&style=flat-square)](https://bun.com)

_**Pi IMproved. Another shitty harness, but Bun-native.**_

A Bun-native **distribution of [Pi](https://pi.dev/)** — what Ubuntu is to Linux, or LazyVim to Neovim: Pi itself, plus web access, subagents, revamped core tools, ANSI-compatible themes, fzf-style completions, and Telegram and web frontends. Not a fork and not a reimplementation: Pi ships _inside_ Pim, and everything you already know about Pi still applies. Preliminary score of [37.8% on Terminal-Bench 2.0](#terminal-bench-20) with locally hosted Qwen3.6-35B, rivalling Claude Code + Sonnet 4.5.

- [Quick Start](#quick-start)
  - [Enabling/Disabling Extensions](#enablingdisabling-extensions)
  - [API Keys (Optional)](#api-keys-optional)
  - [Recommended Pi Settings (Optional)](#recommended-pi-settings-optional)
- [Why Pim?](#why-pim)
  - [Nothing About Pi Changes](#nothing-about-pi-changes)
  - [Lean System Prompt](#lean-system-prompt)
  - [Model-Aware Tools](#model-aware-tools)
  - [Terminal-Bench 2.0](#terminal-bench-20)
- [Agent Tools](#agent-tools)
- [Terminal UI](#terminal-ui)
- [Web UI](#web-ui)
- [Telegram Bot](#telegram-bot)
  - [Setup](#setup)
  - [Commands](#commands)
  - [Features](#features)
- [Changelog](#changelog)
- [Developing](#developing)

![Pim Demo](https://raw.githubusercontent.com/AaronCQL/pim-agent/refs/heads/main/assets/demo.webp)

## Quick Start

One command. Pim brings its own Pi, so [Bun](https://bun.com/docs/installation) is the only prerequisite (_or ask your agent to install it for you_):

```sh
bun install -g pim-agent

pim
```

That's it — there is no `pi install` step and nothing is written to your Pi settings. For all things related to Pi, refer to [Pi's comprehensive docs](https://pi.dev/docs/latest); they apply verbatim.

> [!IMPORTANT]
> **Use `pim` instead of `pi`.** The `pim` command is a drop-in replacement that [runs Pi under Bun](./bin/pim.ts), enabling Bun-specific APIs. `pim --version` prints both versions — Pim's, and the Pi it bundles.

Update the same way you installed:

```sh
bun install -g pim-agent@latest
```

### Enabling/Disabling Extensions

Pim ships a collection of extensions which are all enabled by default. To disable specific ones that don't suit your needs, run `/extensions` in the TUI to pick from the list, or `/extensions <name>` to toggle one directly. Changes are saved to `~/.pim/settings.json` and take effect on the **next launch**.

Some Pim extensions can be toggled live within the TUI as well: `/powerline` for the Git-aware powerline footer, `/tps` for inference speed reporting.

### API Keys (Optional)

Pim's web tools use [Exa](https://exa.ai) for searching the web and [Jina](https://jina.ai/reader/) for fetching websites as Markdown. These tools still work without API keys, but are subject to the following rate limits (as of May 2026):

- Exa - 1,000 requests per month
- Jina - 20 requests per minute

For heavier usage, add API keys to `~/.pim/settings.json`:

```json
{
  "exa": {
    "apiKey": "api_key_here"
  },
  "jina": {
    "apiKey": "api_key_here"
  }
}
```

Environment variables override `settings.json` when present:

```sh
EXA_API_KEY='api_key_here' JINA_API_KEY='api_key_here' pim
```

### Recommended Pi Settings (Optional)

Add the following settings to your `~/.pi/agent/settings.json` for the best experience with Pim:

```json
{
  "quietStartup": true,
  "editorPaddingX": 1,
  "markdown": {
    "codeBlockIndent": ""
  }
}
```

## Why Pim?

Pim's philosophy is **opinionated but minimal**. Its goal is to improve the out-of-the-box experience for both users and agents, without sacrificing composability with other Pi extensions.

### Nothing About Pi Changes

Pim is a distribution, not a fork. Everything Pi does, it keeps doing:

- **Every Pi extension still works.** Pim registers its own extensions in-process, so third-party extensions from your Pi settings load right alongside them, exactly as before.
- **Pi's CLI, sessions and config are unchanged.** Same flags, same `~/.pi` settings, same session files — Pim reads and writes none of them differently, and its own settings live separately in `~/.pim/settings.json`.
- **Your vanilla `pi` keeps working.** Pim never registers itself with Pi and never touches your Pi settings, so `pi` and `pim` coexist on the same machine. Coexistence, not enforcement.

The trade-off is release cadence: Pim pins the exact Pi it was tested against and ships it as a dependency, so a new Pi release does not reach you until Pim's pin moves. That is a deliberate choice — it is what makes the install one command and the combination actually tested — but a stale pin is a user-visible defect, and keeping it current is on us. [File an issue](https://github.com/AaronCQL/pim-agent/issues) if Pim is lagging a Pi release you need; if you need a Pi newer than the pin today, plain `pi` is still right there.

### Lean System Prompt

Pim's system prompt is just **~3K tokens** despite exposing 10+ tools, far leaner than alternatives like OpenCode (~10K) or Hermes (~16K).

This is achieved by having tool descriptions focus on _how_ to use each tool instead of prescribing _when_, since models already appear to internally encode when tools are needed, and prompting them to call tools can [suppress both necessary and unnecessary calls](https://arxiv.org/abs/2605.09252).

### Model-Aware Tools

LLMs are [increasingly post-trained](https://openai.com/index/introducing-codex) for specific agent harnesses, making tool schemas part of the model's learned interface. For text-file editing, Anthropic models are trained to use [string replacement operations](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool), while OpenAI models use [V4A patch operations](https://developers.openai.com/api/docs/guides/tools-apply-patch).

Pim keeps the active toolset model-aware instead of assuming one tool fits every LLM. It dynamically exposes the tools best suited to the selected model, giving each model the interface that best matches its learned behaviour while keeping the prompt lean.

### Terminal-Bench 2.0

| ID | Pim Version | LLM / Model | Results |
| --- | --- | --- | --- |
| [r1](./benchmarks/terminal_bench_2/results/r1/) | [`21d084d1`](https://github.com/AaronCQL/pim-agent/tree/21d084d1) | `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` | **41.6%** (37/89) |
| [r2](./benchmarks/terminal_bench_2/results/r2/) | [`bfd792cf`](https://github.com/AaronCQL/pim-agent/tree/bfd792cf) | `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` | **36.0%** (32/89) |
| [r3](./benchmarks/terminal_bench_2/results/r3/) | [`cd52f3a4`](https://github.com/AaronCQL/pim-agent/tree/cd52f3a4) | `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` | **36.0%** (32/89) |

Preliminary aggregate score of **37.8%** from 3 independent runs. Each ran on an incremental build of Pim, though changes between runs were minor and none were tuned to the benchmark. Pim's `subagent` tool was disabled for all runs to keep each trial single-agent.

On average, Pim solves **~54% more tasks** than [little-coder](https://github.com/itayinbarr/little-coder) with the same Qwen3.6-35B model (37.8% vs 24.6%). This also places Pim in a similar tier to Claude Code + Sonnet 4.5 (40.1%), and above Codex + GPT-5-Mini (31.9%).

The Qwen3.6-35B model is hosted via llama.cpp on an M4 Pro 48GB MacBook, with the following config:

```sh
llama-server \
  -c 131072 \
  -ngl 99 \
  --slot-save-path /tmp/llama-slots \
  --flash-attn on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --jinja \
  --temp 0.6 \
  --top-p 0.95 \
  --top-k 20 \
  --min-p 0.0 \
  --presence-penalty 0.0 \
  --repeat-penalty 1.0 \
  --reasoning-budget 16384 \
  --reasoning-budget-message "Alright, I've thought enough. Let me take the next concrete step now — either a tool call or a final answer — and refine based on what I learn." \
  -np 1
```

_Note 1_: results are preliminary as only 3 independent full runs were conducted; Terminal-Bench 2.0 requires 5 independent full runs under a fixed configuration for an official score.

_Note 2_: the gap with little-coder may be partly explained by different inference configs (128K context vs 32K, Q6_K_XL vs Q4_K_M, higher thinking budget, etc.).

_Note 3_: in r1 and r3, the `code-from-image` trial was counted as non-passing because Qwen autonomously searched for the answer online after legitimately trying for a while.

_Note 4_: see the [`benchmarks/terminal_bench_2`](./benchmarks/terminal_bench_2/) dir for breakdown of results and reproduction steps.

## Agent Tools

Pim revamps Pi's default tools (`bash`, `read`, `write`, `edit`) so they produce consistent behaviour and output, cross-reference each other where useful, and render uniformly in the TUI. It also adds:

- **`apply_patch`** - V4A patch editing, dynamically exposed instead of `edit` for OpenAI models
- **`glob`** - file enumeration by glob pattern, sorted newest-first, respects `.gitignore`
- **`grep`** - regex search across files with context lines, multiline matching, respects `.gitignore`
- **`web_search`** - search the web via [Exa](https://exa.ai) with ranked results and snippets
- **`web_fetch`** - fetch websites as Markdown via [Jina](https://jina.ai/reader/), with browser-rendered fallback via [`Bun.WebView`](https://bun.com/docs/runtime/webview)
- **`subagent`** - delegate complex work to isolated sub-sessions with full tool access
- **`todo`** - in-session task list with a live widget in the UI footer

## Terminal UI

Pim also ships with quality of life improvements for the TUI:

- **ANSI-compatible themes** - `pim-light` and `pim-dark` themes which adapt to your terminal's colour scheme
- **fzf-style autocomplete** - `@path` file picker and `/command` picker with fuzzy search
- **Git-aware powerline footer** - cwd, git branch and states, context usage, model and session cost (toggle with `/powerline`)
- **TPS reporting** - per-cycle decode/prefill rate, TTFT, and cache read tokens (toggle with `/tps`)
- **Concise tool UI** - minimal one-liner title across all tool calls, `Ctrl+O` to toggle full details

## Web UI

Pim ships a browser client for the same agent, served straight from your machine:

```sh
# Serves the web UI and its WebSocket gateway on http://127.0.0.1:4319
pim --mode serve

# Pick a port and interface (PORT is honoured too; --port wins)
pim --mode serve --port 8080 --hostname 0.0.0.0
```

Sessions are shared with the TUI — the web client reads and writes the same Pi session files, so you can start a task in the terminal and pick it up in a browser tab. Files, `@path` completions and skills are resolved on the **server**, i.e. on the machine the agent actually works on.

> [!CAUTION]
> The gateway has no authentication yet. It binds to loopback by default; only put it on a wider interface behind something that does the authenticating for you (a tunnel, a reverse proxy, or a private network like Tailscale).

The prebuilt client is included in the npm package. Installing straight from a git URL skips the build and leaves you without it — npm is the supported path.

## Telegram Bot

Run Pim as a Telegram bot with full agent capabilities in your DMs or group chats (supports threads).

### Setup

Create `~/.pim/telegram/config.json` with your bot token (from [@BotFather](https://t.me/BotFather)) and an allowlist of chat IDs the bot will respond to:

```json
{
  "token": "YOUR_TELEGRAM_BOT_TOKEN",
  "allow": [123456789, 987654321]
}
```

Then, install and run as a persistent daemon (_recommended_):

```sh
# Supports Linux (systemd) and macOS (launchd)
pim --mode telegram --install

# Tear down
pim --mode telegram --uninstall
```

The daemon auto-restarts on failure and supports the `/update` command for in-chat updates.

For development, run standalone with `pim --mode telegram` instead.

### Commands

> [!TIP]
> Use `/commands` on your bot for all commands to show up on your Telegram UI.

| Command      | Description                                        |
| ------------ | -------------------------------------------------- |
| `/cancel`    | Cancel the current turn                            |
| `/cd`        | Show or change the working directory               |
| `/chatid`    | Show this chat's numeric ID                        |
| `/clear`     | Reset chat history and context window              |
| `/commands`  | Register all commands with Telegram                |
| `/compact`   | Compact the current session context                |
| `/effort`    | Show or change thinking effort level               |
| `/logs`      | Show or change log verbosity                       |
| `/model`     | Show or change the AI model                        |
| `/temporary` | Toggle temporary chat (fresh session each message) |
| `/update`    | Update the bot to the latest version               |
| `/usage`     | Show context window and session cost               |

### Features

- ⏰ **Scheduled tasks** - your bot can create one-time, interval, or cron-based tasks that fire automatically; ask your bot to schedule something.
- 👀 **Live progress logs** - use `/logs` to choose what you see while the agent works: final replies, tool use, intermediate text, or thinking.
- 📝 **Rich Markdown** - supports Telegram's [rich text formatting](https://telegram.org/blog/watch-apps-and-more#obscenely-rich-text-formatting-for-bots) with full markdown and LaTeX math support.
- 📎 **Rich media** - send photos, documents, videos, audio, and voice messages directly in chat; your bot can also send files back to you.
- 🧵 **Thread-specific prompts** - each chat (or thread) gets its own session and optional instructions; ask your bot to modify its instructions.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Developing

```sh
# Link locally and launch:
bun dev
```

`bun dev` runs `bun link` and launches `pim` from this checkout, with the local extensions loaded in-process. Restart `pim` to pick up edits: `/reload` reloads Pi's own resources, but Pim's extensions are already-imported modules and will not be re-read.

See [AGENTS.md](./AGENTS.md) for the developer guide.
