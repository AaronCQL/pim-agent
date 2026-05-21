#!/usr/bin/env bash
# Run Pim Agent on Terminal-Bench 2.0 via Harbor's BaseInstalledAgent flow.
#
# Usage:
#   ./benchmarks/terminal_bench_2/run.sh                # default output dir
#   ./benchmarks/terminal_bench_2/run.sh /tmp/tb2-runs  # custom output dir
#
# Env overrides:
#   TB_PIM_MODEL     model spec passed to pim (default: read from ~/.pi/agent/models.json)
#   TB_N_CONCURRENT  number of parallel containers (default: 1)
#   TB_TASK          run a single task by id (smoke testing)
#   TB_DEBUG         set to 1 for harbor --debug
#
# Prerequisites:
#   - Docker running
#   - harbor installed (pip install harbor  OR  uv tool install harbor)
#   - Pi's models.json present at ~/.pi/agent/models.json with a provider entry
#   - Required host env vars set (see .env.example)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

OUTPUT_DIR="${1:-$REPO_ROOT/benchmarks/terminal_bench_2/runs}"
N_CONCURRENT="${TB_N_CONCURRENT:-1}"

PI_MODELS="${HOME}/.pi/agent/models.json"

if [ ! -f "$PI_MODELS" ]; then
    echo "ERROR: pi models config not found at $PI_MODELS"
    echo "       Create it (with a provider entry) before running this benchmark."
    exit 1
fi

# Pluck the first baseUrl from pi's models.json, then host:port.
LLM_URL=$(python3 -c "
import json, sys
cfg = json.load(open('$PI_MODELS'))
providers = cfg.get('providers') or {}
for name, p in providers.items():
    if p.get('baseUrl'):
        print(name, p['baseUrl'])
        sys.exit(0)
sys.exit('no provider with baseUrl in models.json')
")
TB_LLM_PROVIDER=$(echo "$LLM_URL" | awk '{print $1}')
TB_LLM_HOST=$(echo "$LLM_URL" | awk '{print $2}' | sed -E 's#https?://##; s#[:/].*##')
TB_LLM_HOST_IP=$(getent hosts "$TB_LLM_HOST" | awk '{print $1}' | head -1)

if [ -z "$TB_LLM_HOST_IP" ]; then
    echo "ERROR: could not resolve $TB_LLM_HOST"
    echo "       Check Tailscale / DNS on this host."
    exit 1
fi

# Default model: first model id under the resolved provider.
DEFAULT_MODEL=$(python3 -c "
import json
cfg = json.load(open('$PI_MODELS'))
p = cfg['providers']['$TB_LLM_PROVIDER']
models = p.get('models') or []
if not models:
    raise SystemExit('no models under $TB_LLM_PROVIDER in models.json')
print(f\"$TB_LLM_PROVIDER/{models[0]['id']}\")
")
MODEL="${TB_PIM_MODEL:-$DEFAULT_MODEL}"

echo "=== Pim Agent · Terminal-Bench 2.0 (installed-agent) ==="
echo "Repo      : $REPO_ROOT"
echo "Provider  : $TB_LLM_PROVIDER"
echo "Host      : $TB_LLM_HOST -> $TB_LLM_HOST_IP"
echo "Model     : $MODEL"
echo "Concurrent: $N_CONCURRENT"
echo "Output    : $OUTPUT_DIR"
[ -n "${TB_TASK:-}" ] && echo "Task      : $TB_TASK (single-task smoke)"
echo "========================================================"

command -v harbor >/dev/null || { echo "ERROR: harbor not found. pip install harbor"; exit 1; }
command -v docker >/dev/null || { echo "ERROR: docker not found"; exit 1; }

export PIM_REPO_ROOT="$REPO_ROOT"
export TB_LLM_HOST TB_LLM_HOST_IP

cd "$REPO_ROOT"

EXTRA_ARGS=()
if [ -n "${TB_TASK:-}" ]; then
    EXTRA_ARGS+=(--include-task-name "$TB_TASK" --n-tasks 1)
fi
[ "${TB_DEBUG:-0}" = "1" ] && EXTRA_ARGS+=(--debug)

harbor run \
    --dataset terminal-bench@2.0 \
    --agent-import-path benchmarks.terminal_bench_2.adapter:PimAgent \
    --extra-docker-compose "$HERE/overlay.yaml" \
    --model "$MODEL" \
    --jobs-dir "$OUTPUT_DIR" \
    --n-concurrent "$N_CONCURRENT" \
    --yes \
    "${EXTRA_ARGS[@]}"
