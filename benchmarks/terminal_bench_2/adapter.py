"""Harbor BaseInstalledAgent adapter for Pim Agent on Terminal-Bench 2.0.

Pim source is bind-mounted at /opt/pim by overlay.yaml. install() installs
Bun and the pi-coding-agent CLI globally so pim's launcher can resolve them.
run() shells out to `bun /opt/pim/bin/pim.ts --print --mode json ...` and
tees pim's JSONL event stream to /logs/agent/pim.txt; post-run we parse
that log for token usage and cost.

Modelled on harbor.agents.installed.pi.Pi.

Launch:

    ./benchmarks/terminal_bench_2/run.sh
"""
from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

CONTAINER_PIM_DIR = "/opt/pim"
LOG_DIR = "/logs/agent"
OUTPUT_FILENAME = "pim.txt"
DEFAULT_TIMEOUT_SEC = 10800  # 3h

HOST_PI_MODELS = Path.home() / ".pi" / "agent" / "models.json"


class PimAgent(BaseInstalledAgent):
    """Pim Agent on Terminal-Bench 2.0 via Harbor's installed-agent flow."""

    _OUTPUT_FILENAME = OUTPUT_FILENAME

    @staticmethod
    def name() -> str:
        return "pim"

    def get_version_command(self) -> str | None:
        return (
            'export PATH="$HOME/.bun/bin:$PATH"; '
            f"bun {CONTAINER_PIM_DIR}/bin/pim.ts --version"
        )

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && "
                "apt-get install -y --no-install-recommends "
                "curl ca-certificates unzip git coreutils python3 && "
                f"mkdir -p {LOG_DIR} && chmod 0777 {LOG_DIR}"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        # Install Bun for the agent user.
        await self.exec_as_agent(
            environment,
            command="curl -fsSL https://bun.sh/install | bash",
        )

        # Install pi globally so pim's launcher resolves it.
        await self.exec_as_agent(
            environment,
            command="~/.bun/bin/bun install -g @earendil-works/pi-coding-agent",
        )

        # Sanity-check the bind mount.
        await self.exec_as_agent(
            environment,
            command=f"test -f {CONTAINER_PIM_DIR}/bin/pim.ts",
        )

        # Provision pi's models.json so the container's pi sees the same
        # provider config as the host (custom baseUrl, model ids, etc.).
        if HOST_PI_MODELS.exists():
            models_json = HOST_PI_MODELS.read_text()
            await self.exec_as_agent(
                environment,
                command=(
                    "mkdir -p ~/.pi/agent && "
                    'printf "%s" "$PIM_MODELS_JSON" > ~/.pi/agent/models.json'
                ),
                env={"PIM_MODELS_JSON": models_json},
            )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("model_name is required")

        provider = self.model_name.split("/", 1)[0] if "/" in self.model_name else ""
        env = self._collect_env(provider)

        cmd = self._build_pim_command(self.model_name, instruction)

        await self.exec_as_agent(
            environment,
            command=cmd,
            env=env,
            timeout_sec=DEFAULT_TIMEOUT_SEC,
        )

    @staticmethod
    def _collect_env(provider: str) -> dict[str, str]:
        """Forward host env vars the agent needs inside the container.

        Local providers (ollama/llamacpp) get their baseUrl + apiKey from
        the models.json written into the container during install(), so
        no env vars are needed for them. Hosted-provider API keys and
        web-tool keys are forwarded if set on the host.
        """
        env: dict[str, str] = {}

        provider_keys: dict[str, list[str]] = {
            "anthropic": ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
            "openai": ["OPENAI_API_KEY"],
            "google": [
                "GEMINI_API_KEY",
                "GOOGLE_GENERATIVE_AI_API_KEY",
                "GOOGLE_API_KEY",
            ],
            "groq": ["GROQ_API_KEY"],
            "openrouter": ["OPENROUTER_API_KEY"],
            "mistral": ["MISTRAL_API_KEY"],
            "xai": ["XAI_API_KEY"],
        }
        forward = provider_keys.get(provider, []) + ["EXA_API_KEY", "JINA_API_KEY"]
        for key in forward:
            val = os.environ.get(key)
            if val:
                env[key] = val
        return env

    @staticmethod
    def _build_pim_command(model: str, instruction: str) -> str:
        # pim.ts internally spawns `bun pm -g bin` to locate the global pi
        # install, so bun must be on PATH (not just invoked by absolute path).
        # Enumerate Pim's extensions at exec time; each needs its own -e flag.
        # Pipe through filter.py to drop streaming-delta event bloat - pim's
        # raw JSON output is ~1 GB per task, the filter reduces that ~1000x
        # while preserving message_end events (content + usage).
        # `--` hands the raw instruction to pim, which forwards it via pi's
        # stdin so prompts starting with `-` aren't parsed as flags.
        return (
            "set -e; "
            'export PATH="$HOME/.bun/bin:$PATH"; '
            "EXTS=''; "
            f"for f in {CONTAINER_PIM_DIR}/src/extensions/*/index.ts; do "
            "  EXTS=\"$EXTS -e $f\"; "
            "done; "
            f"bun {CONTAINER_PIM_DIR}/bin/pim.ts "
            "--print --mode json --no-session --no-context-files "
            f"--model {shlex.quote(model)} $EXTS -- {shlex.quote(instruction)} "
            "2>&1 </dev/null "
            f"| python3 -u {CONTAINER_PIM_DIR}/benchmarks/terminal_bench_2/filter.py "
            f"| stdbuf -oL tee /logs/agent/{OUTPUT_FILENAME}"
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / OUTPUT_FILENAME
        if not output_file.exists():
            return

        n_input = 0
        n_output = 0
        n_cache_read = 0
        n_cache_write = 0
        total_cost = 0.0

        for raw in output_file.read_text().splitlines():
            line = raw.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "message_end":
                continue
            message = event.get("message") or {}
            if message.get("role") != "assistant":
                continue
            usage = message.get("usage") or {}
            n_input += usage.get("input", 0)
            n_output += usage.get("output", 0)
            n_cache_read += usage.get("cacheRead", 0)
            n_cache_write += usage.get("cacheWrite", 0)
            cost = usage.get("cost") or {}
            total_cost += cost.get("total", 0.0)

        context.n_input_tokens = n_input + n_cache_read
        context.n_output_tokens = n_output
        context.n_cache_tokens = n_cache_read
        context.cost_usd = total_cost if total_cost > 0 else None
