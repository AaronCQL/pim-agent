# Pim Agent · Terminal-Bench 2.0

Run [Pim Agent](https://github.com/AaronCQL/pim-agent) on [Terminal-Bench 2.0](https://www.tbench.ai/leaderboard/terminal-bench/2.0) via [Harbor](https://www.harborframework.com) as an installed-agent (`BaseInstalledAgent`). Pim's source is bind-mounted into each task container; all of Pim's tools run natively in-container against the task workspace. The `subagent` extension is excluded by `adapter.py` to keep runs single-agent.

## Quick Start

```bash
# Single-task smoke (fast)
TB_TASK=hello-world ./benchmarks/terminal_bench_2/run.sh

# Full run, default model + output dir
./benchmarks/terminal_bench_2/run.sh

# Custom output dir + parallel
./benchmarks/terminal_bench_2/run.sh /tmp/tb2-runs
TB_N_CONCURRENT=4 ./benchmarks/terminal_bench_2/run.sh
```

Prerequisites:

- Docker running
- `harbor` installed (`pip install harbor` or `uv tool install harbor`)
- `~/.pi/agent/models.json` configured with at least one provider+model. `run.sh` parses this to derive the default model and to pin the model-server hostname into the container via `extra_hosts`.
- Model server reachable from this host (incl. Tailscale resolution if applicable). `run.sh` resolves the hostname with `getent hosts` and injects the IP into the overlay.
- Required env vars exported on the host (see [`.env.example`](./.env.example)) — pass with `--env-file` if preferred

## Architecture

```
run.sh
  ├── reads ~/.pi/agent/models.json, picks first provider+model
  ├── resolves model-server hostname (Tailscale or LAN) to IP
  ├── exports PIM_REPO_ROOT, TB_LLM_HOST, TB_LLM_HOST_IP
  └── harbor run --extra-docker-compose overlay.yaml --agent-import-path ...
       │
       ↓
overlay.yaml          → extra_hosts: pin LLM host to its IP
                      → volumes:     bind-mount $PIM_REPO_ROOT → /opt/pim:ro
       │
       ↓
PimAgent.install()    → exec_as_root: apt deps + /logs/agent
                      → exec_as_agent: install Bun, install pi globally
                      → exec_as_agent: write ~/.pi/agent/models.json from host
PimAgent.run()        → exec_as_agent: bun /opt/pim/bin/pim.ts --print --mode json ...
                      → tee /logs/agent/pim.txt
PimAgent.populate_context_post_run()
                      → parse pim.txt for usage → context.{n_input,n_output,n_cache_tokens,cost_usd}
```

Files:

| File | Role |
| --- | --- |
| `adapter.py` | `BaseInstalledAgent` subclass. Handles install, run, JSONL parsing. |
| `overlay.yaml` | docker-compose overlay: `extra_hosts` for host gateway + bind mount `${PIM_REPO_ROOT}` → `/opt/pim`. |
| `run.sh` | Wrapper around `harbor run` with the right flags. Exports `PIM_REPO_ROOT`. |
| `filter.py` | Streaming JSONL filter that strips `*_delta` bloat from pim's raw output (~1000x reduction). |
| `to_atif.py` | Converts `pim.txt` agent logs to ATIF v1.7 `trajectory.json` files for Harbor submission. |
| `.env.example` | Documents required host env vars (Anthropic / Exa / Jina / local model stubs). |

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `TB_PIM_MODEL` | `llamacpp/qwen3.6-35b-a3b` | Model spec passed to pim |
| `TB_N_CONCURRENT` | `1` | Parallel task containers |
| `TB_TASK` | _(unset)_ | Run a single named task instead of the full dataset |
| `PIM_REPO_ROOT` | `<repo root>` | Path bind-mounted at `/opt/pim` (set by `run.sh`) |

## Smoke test

Before a full run, validate the pipeline with a single easy task:

```bash
TB_TASK=hello-world ./benchmarks/terminal_bench_2/run.sh /tmp/pim-smoke
```

Then inspect `/tmp/pim-smoke/<run-id>/<task>/agent/pim_agent.log` and `pim.log` to confirm Bun installed, the pim bind-mount resolved, and pim emitted a sensible JSONL stream.

## Troubleshooting

- **`extra_docker_compose` ignored** — verify `harbor run` accepts `--extra-docker-compose <path>`; older harbor versions used a different flag.
- **`bun: command not found`** in container — install step failed; check `install` logs in the trial output dir.
- **Model unreachable** — from inside a task container, `curl http://host.docker.internal:8888/v1/models` should return JSON. On Linux this requires `host.docker.internal:host-gateway` from `overlay.yaml`.
- **`@earendil-works/pi-coding-agent` not found** — `bun install -g` failed; check container has egress (`allow_internet=true` in task `[environment]`).
- **Pim tools error in `--print` mode** — TUI-only extensions may misbehave with `--print`. If so, narrow with `--tools Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch` (modify `adapter.py:_build_pim_command`).
