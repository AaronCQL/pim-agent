# Pim Agent

_Pim Agent is to Pi Agent what Vim is to Vi._

A Bun-native, opinionated extension pack for [Pi Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## Quick Start

Assumes [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and [`bun`](https://bun.com/docs/installation) are already installed globally.

```bash
# Install the Pim Agent extension pack
pi install npm:@aaroncql/pim-agent

# Install the `pim` launcher via Bun
bun install -g @aaroncql/pim-agent

# Launch pim
pim
```

`pim` is a thin Bun launcher around `pi` so that Pim Agent's Bun-specific tooling works. Other extensions and packages registered with Pi continue to work normally.

## Developing

Assuming you are in this repo:

```bash
# Link locally and launch pim
bun dev
```

Pim Agent is registered as a project-local Pi package via `.pi/settings.json`. Pi auto-loads it when launched from within this repo. Outside this repo, `pim` is still on PATH but no Pim Agent package is loaded.

- To reload Pim Agent after edits, run the built-in `/reload` command
- To tear down, run `bun unlink` within this dir
