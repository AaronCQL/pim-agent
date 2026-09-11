<!-- omit in toc -->
# PIM - Pi IMproved

[![npm version](https://img.shields.io/npm/v/pim-agent?style=flat-square)](https://www.npmjs.com/package/pim-agent)
[![npm downloads](https://img.shields.io/npm/dm/pim-agent?style=flat-square)](https://www.npmjs.com/package/pim-agent)
[![license](https://img.shields.io/npm/l/pim-agent?style=flat-square)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun&style=flat-square)](https://bun.com)

_**Pim is to Pi what Vim is to Vi.**_

An opinionated distro of [Pi](https://pi.dev/): built-in web access, subagents, revamped core tools, ANSI-compatible themes, fzf-style completions, alternate frontends (Web & Telegram), and compatible with other Pi extensions. Preliminary score of [37.8% on Terminal-Bench 2.0](#terminal-bench-20) with locally hosted Qwen3.6-35B, rivalling Claude Code + Sonnet 4.5.

- [Quick Start](#quick-start)
  - [Toggling Features](#toggling-features)
  - [API Keys (Optional)](#api-keys-optional)
  - [Recommended Pi Settings (Optional)](#recommended-pi-settings-optional)
- [Why Pim?](#why-pim)
  - [Pi Core](#pi-core)
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

Ensure that you have [Bun](https://bun.com/docs/installation) already installed:

```sh
# Install pim:
bun install -g pim-agent

# Launch pim:
pim

# Update pim (pi comes along with it):
pim update
```

### Toggling Features

Pim ships a collection of features, nearly all enabled by default. To enable or disable specific features, run `/pim` in the TUI and toggle from the list. The changes apply to the running session immediately.

### API Keys (Optional)

`web_search` tries [Exa](https://exa.ai) → [Firecrawl](https://www.firecrawl.dev/) → DuckDuckGo (via [Jina](https://jina.ai/reader/) reader), and `web_fetch` uses Jina with a `Bun.WebView` fallback. These tools still work without API keys, but are subject to the following keyless rate limits (as of Sept 2026):

- Exa - 1,000 requests per month
- Firecrawl - daily limit per IP
- Jina - 20 requests per minute

For heavier usage, add API keys to `~/.pim/settings.json`:

```json
{
  "exa": {
    "apiKey": "api_key_here"
  },
  "firecrawl": {
    "apiKey": "api_key_here"
  },
  "jina": {
    "apiKey": "api_key_here"
  }
}
```

Environment variables take precedence over `settings.json` when set:

```sh
EXA_API_KEY='api_key_here' FIRECRAWL_API_KEY='api_key_here' JINA_API_KEY='api_key_here' pim
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

### Pi Core

Think of Pim as an opinionated distro of Pi (like what Ubuntu is to Linux). Pim uses Pi in its core, and everything Pi does, it continues to do:

- **Every Pi extension still works.** Pim registers its own extensions in-process, so third-party extensions from your Pi settings load right alongside them, exactly as before.
- **Pi's CLI, sessions and config are unchanged.** Only Pim's own settings live separately in `~/.pim/settings.json`.
- **Your vanilla `pi` keeps working.** Pim never registers itself with Pi and never touches your Pi settings, so `pi` and `pim` can both be used on the same machine.

### Lean System Prompt

Pim's system prompt is just **~3K tokens** despite exposing 10+ tools, far leaner than alternatives like OpenCode (~10K), Hermes (~16K), or Claude Code (~30K).

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

Pim revamps Pi's default tools (`bash`, `read`, `write`, `edit`) so they produce consistent behaviour and output, cross-reference each other where useful, and render uniformly in your UIs. It also adds:

- **`apply_patch`** - V4A patch editing, dynamically exposed instead of `edit` for OpenAI and select Claude models
- **`glob`** - file enumeration by glob pattern, sorted newest-first, respects `.gitignore`
- **`grep`** - regex search across files with context lines, multiline matching, respects `.gitignore`
- **`web_search`** - search the web via [Exa](https://exa.ai) with ranked results and snippets
- **`web_fetch`** - fetch websites as Markdown via [Jina](https://jina.ai/reader/), with browser-rendered fallback via [`Bun.WebView`](https://bun.com/docs/runtime/webview)
- **`subagent`** - delegate complex work to isolated sub-sessions with full tool access, each keeping its own transcript under `~/.pim/subagents` for 30 days

## Terminal UI

Pim also ships with quality of life improvements for the TUI:

- **ANSI-compatible themes** - `pim-light` and `pim-dark` themes which adapt to your terminal's colour scheme
- **fzf-style autocomplete** - `@path` file picker and `/command` picker with fuzzy search
- **Git-aware powerline footer** - cwd, git branch and states, context usage, model and session cost (run `/pim` to disable)
- **TPS reporting** - per-cycle decode/prefill rate, TTFT, and cache read tokens (disabled by default; run `/pim` to enable)
- **Concise tool UI** - minimal one-liner title across all tool calls, `Ctrl+O` to toggle full details

## Web UI

<!-- TODO -->

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
