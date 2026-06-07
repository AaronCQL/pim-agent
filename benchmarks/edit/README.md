# editing-tool micro-benchmark

A cheap, deterministic harness that pits editing tools against each other across models. The built-in lanes are Pim's own `edit` and `apply_patch`; a third lane, `hashline`, runs the external [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) extension. It isolates **tool proficiency** from coding ability: every task is a fully-specified, tool-neutral change with a known golden file, so the only variable is whether the model can express that change correctly in a given tool's format.

It answers two questions:

1. **How much does prior training/knowledge on a tool format help?** Claude models are trained on the `str_replace` shape; GPT/Codex models on the `apply_patch` (V4A) shape. Run the same tasks through each model with each tool and compare the within-model gap between the native and foreign format.
2. **Token usage within a model.** For the same model and task, which tool requires fewer input/output tokens (and costs less)?

## How each run is set up

Each run launches pim non-interactively against a fresh temp copy of the task file, with **exactly one editing tool plus a `read`**:

```
# edit / apply_patch (pim's own tools, paired with pim's read):
pim --print --mode json --no-session --no-context-files \
    --no-extensions --no-builtin-tools \
    --extension <repo>/src/extensions/{edit|apply-patch}/index.ts \
    --extension <repo>/src/extensions/read/index.ts \
    --tools {edit|apply_patch},read --model <spec> -- <prompt>

# hashline (the extension bundles its own read; pim's read is NOT loaded):
pim --print --mode json --no-session --no-context-files \
    --no-extensions --no-builtin-tools \
    --extension <hashline>/index.ts \
    --tools edit,read --model <spec> -- <prompt>
```

`--no-builtin-tools --no-extensions` means only the explicitly-loaded extensions register tools, so exactly one editing tool exists (the model-based `edit`/`apply_patch` swap in `apply-patch/coordinator.ts` cannot fire). No pim code change is needed to pin the editing tool.

By default the harness mirrors production: it does not paste the file into the prompt, so the model discovers the contents with the lane's `read` and then edits, just as it does in a real session. For `edit`/`apply_patch` that is pim's `read` (the same `LINE:`-prefixed output the `edit` schema refers to); for `hashline` it is the extension's own `read`, which emits `LINE#HASH:` anchors that its `edit` then references. There is no `bash` or `write`, so the model cannot bypass the tool under test. Pass `--inline` to instead paste the file into the prompt and drop `read`, which isolates raw format proficiency at lower cost and variance (useful as a controlled A/B against the realistic mode). `--inline` is **incompatible with `hashline`** — its edits need hash anchors that only its `read` emits — so that lane is skipped under `--inline`.

Scoring is an exact byte comparison of the edited file against `after/` (normalized for CRLF and trailing newlines), with no LLM judge.

## Run it

```bash
# All tasks, the edit + apply_patch lanes, the models in ~/.pi/agent/models.json,
# 3 reps each (hashline is opt-in; pass --tools to include it):
bun benchmarks/edit/run.ts

# Target specific models and a single task, 5 reps:
bun benchmarks/edit/run.ts \
  --models anthropic/claude-opus-4-8,openai/gpt-5 --task rename-in-file --reps 5

# Include the hashline lane (install the extension first, see below):
pi install npm:pi-hashline-edit
bun benchmarks/edit/run.ts --tools edit,apply_patch,hashline

# Re-print the table for a past run (defaults to the latest):
bun benchmarks/edit/report.ts
bun benchmarks/edit/report.ts benchmarks/edit/runs/<stamp>
```

The `hashline` lane needs the external extension on disk. `pi install npm:pi-hashline-edit` installs it at `~/.pi/agent/npm/node_modules/pi-hashline-edit/index.ts`, which the harness uses by default; point `--hashline-path` at a clone (a directory or a direct `index.ts`) to override. The run aborts with an install hint if the lane is selected but the extension is missing.

Flags: `--models a,b` · `--tools edit,apply_patch,hashline` · `--reps N` · `--task id1,id2` · `--tag S,M` · `--inline` (paste file, drop read; skips hashline) · `--hashline-path <dir-or-index.ts>` · `--concurrency N` (default 1) · `--timeout SEC` (default 120, per run) · `--out DIR` · `--no-keep` (delete work dirs).

> Note: `--tools` defaults to `edit,apply_patch` only. List `hashline` explicitly to run it.

Output lands in `runs/<timestamp>/` (gitignored): `results.jsonl` (one row per run), `config.json`, `summary.txt`, and a `work/` dir with each run's edited file, the kept JSONL events (`run.jsonl`), and `result.json` for inspection.

## Tasks

Each `tasks/<id>/` has `task.json` (a tool-neutral instruction), a `before/` file, and an `after/` golden. The starter corpus spans the dimensions where the tools diverge:

| id | axis | stresses |
| --- | --- | --- |
| `single-edit` | format | single literal edit (baseline; edit's cheap end) |
| `scattered-edits` | format | three scattered edits in one file (batched into one call) |
| `rename-in-file` | format | rename an identifier at 4 sites (replaceAll vs N hunks) |
| `delete-function` | format | delete a function and its call site |
| `long-file` | format | two edits in a longer file (file-size scaling) |
| `duplicate-blocks` | context-ratio | edit one of two identical blocks (needs surrounding context) |
| `repetitive-list` | context-ratio | change one field deep in a repetitive list (edit duplicates the context; apply_patch leaner) |
| `repetitive-list-large` | context-ratio | the same single deep edit in a 60-entry list (does file size flip the verdict?) |
| `rewrite-body` | block | replace a whole function body (apply_patch's per-line markers cost more; edit leaner) |
| `multifile-rename` | multifile | rename across three files (one `apply_patch` envelope vs one `edit` call per file) |
| `multifile-rename-wide` | multifile | the same rename across six files (the multi-file gap, scaled up) |
| `many-field-edits` | edit-density | twelve independent field edits after one read (amortize the read; stress re-anchoring) |

The `axis` value is the `tag` field in `task.json`, so `--tag multifile` runs just that group. The five axes map to where the tools structurally diverge: `format` (basic single-file edits, where edit is even or slightly cheaper), `context-ratio` and `block` (single-file token tradeoffs), `multifile` (round-trips, where apply_patch batches one envelope), and `edit-density` (one read amortized over many edits, hashline's best case).

Add a task by creating a new `tasks/<id>/` with the same three parts. Keep the instruction precise enough that `before` + instruction determines `after` exactly, so exact-match scoring stays valid.

The benchmark TypeScript is typechecked via its own tsconfig: `bunx tsgo --noEmit -p benchmarks/edit`.
