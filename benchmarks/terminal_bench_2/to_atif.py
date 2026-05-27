#!/usr/bin/env python3
"""Convert pim.txt agent logs to ATIF v1.7 trajectory.json.

Reads the filtered JSONL event stream that pim produces (via filter.py) and
emits a single ATIF trajectory JSON file per task.

Usage:
    # Single task
    python to_atif.py runs/r1/.../task-name__abc/

    # Entire job (all tasks in a job directory)
    python to_atif.py runs/r1/2026-05-26__11-25-13/

    # Entire run (all jobs under a run directory)
    python to_atif.py runs/r1/
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_pim_log(pim_path: Path) -> tuple[dict | None, list[dict], dict | None]:
    """Parse a pim.txt into (session, user_messages, turn_ends).

    Returns:
        session: the session event dict (or None)
        user_messages: list of message_end events with role "user"
        turn_ends: list of turn_end events (each is a complete agent turn)
    """
    session = None
    user_messages: list[dict] = []
    turn_ends: list[dict] = []

    for raw in pim_path.read_text().splitlines():
        line = raw.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        t = ev.get("type", "")

        if t == "session":
            session = ev
        elif t == "message_end":
            msg = ev.get("message") or {}
            if msg.get("role") == "user":
                user_messages.append(msg)
        elif t == "turn_end":
            turn_ends.append(ev)

    return session, user_messages, turn_ends


def extract_text(content: list[dict]) -> str:
    """Concatenate all text blocks from a content array."""
    parts = []
    for c in content:
        if c.get("type") == "text":
            parts.append(c.get("text", ""))
    return "\n".join(parts)


def extract_thinking(content: list[dict]) -> str | None:
    """Concatenate all thinking blocks from a content array."""
    parts = []
    for c in content:
        if c.get("type") == "thinking":
            text = c.get("thinking", "")
            if text:
                parts.append(text)
    return "\n".join(parts) if parts else None


def extract_tool_calls(content: list[dict]) -> list[dict] | None:
    """Extract tool calls from a content array into ATIF ToolCall format."""
    calls = []
    for c in content:
        if c.get("type") == "toolCall":
            calls.append({
                "tool_call_id": c["id"],
                "function_name": c["name"],
                "arguments": c.get("arguments", {}),
            })
    return calls if calls else None


def extract_observation(tool_results: list[dict] | None) -> dict | None:
    """Convert pim toolResults into an ATIF Observation."""
    if not tool_results:
        return None

    results = []
    for tr in tool_results:
        content_parts = tr.get("content", [])
        text_parts = []
        for cp in content_parts:
            if cp.get("type") == "text":
                text_parts.append(cp.get("text", ""))
        content_str = "\n".join(text_parts) if text_parts else None

        results.append({
            "source_call_id": tr.get("toolCallId"),
            "content": content_str,
        })

    return {"results": results} if results else None


def extract_metrics(usage: dict | None) -> dict | None:
    """Convert pim usage dict into ATIF Metrics."""
    if not usage:
        return None
    prompt = usage.get("input", 0) + usage.get("cacheRead", 0)
    completion = usage.get("output", 0)
    cached = usage.get("cacheRead", 0)
    cost = (usage.get("cost") or {}).get("total")

    return {
        "prompt_tokens": prompt if prompt else None,
        "completion_tokens": completion if completion else None,
        "cached_tokens": cached if cached else None,
        "cost_usd": cost if cost else None,
    }


def ms_to_iso(ts_ms: int | float | None) -> str | None:
    """Convert a millisecond Unix timestamp to ISO 8601."""
    if ts_ms is None:
        return None
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return dt.isoformat()


def convert(task_dir: Path) -> dict:
    """Convert a single task directory to an ATIF trajectory dict."""
    pim_path = task_dir / "agent" / "pim.txt"
    result_path = task_dir / "result.json"

    if not pim_path.exists():
        raise FileNotFoundError(f"No pim.txt at {pim_path}")
    if not result_path.exists():
        raise FileNotFoundError(f"No result.json at {result_path}")

    result = json.loads(result_path.read_text())
    agent_info = result.get("agent_info", {})

    session, user_messages, turn_ends = parse_pim_log(pim_path)

    steps: list[dict] = []
    step_id = 1

    # Step 1: user instruction
    if user_messages:
        user_msg = user_messages[0]
        user_content = user_msg.get("content", [])
        user_text = extract_text(user_content)
        steps.append({
            "step_id": step_id,
            "timestamp": ms_to_iso(user_msg.get("timestamp")),
            "source": "user",
            "message": user_text,
        })
        step_id += 1

    # Remaining steps: one per turn_end
    total_prompt = 0
    total_completion = 0
    total_cached = 0
    total_cost = 0.0

    for turn in turn_ends:
        msg = turn.get("message") or {}
        content = msg.get("content", [])
        usage = msg.get("usage")
        tool_results = turn.get("toolResults")

        text = extract_text(content)
        thinking = extract_thinking(content)
        tool_calls = extract_tool_calls(content)
        observation = extract_observation(tool_results)
        metrics = extract_metrics(usage)

        if metrics:
            total_prompt += metrics.get("prompt_tokens") or 0
            total_completion += metrics.get("completion_tokens") or 0
            total_cached += metrics.get("cached_tokens") or 0
            total_cost += metrics.get("cost_usd") or 0.0

        step: dict = {
            "step_id": step_id,
            "timestamp": ms_to_iso(msg.get("timestamp")),
            "source": "agent",
            "message": text if text else "",
            "llm_call_count": 1,
        }
        if thinking:
            step["reasoning_content"] = thinking
        if tool_calls:
            step["tool_calls"] = tool_calls
        if observation:
            step["observation"] = observation
        if metrics:
            step["metrics"] = metrics

        steps.append(step)
        step_id += 1

    if not steps:
        raise ValueError(f"No steps found in {pim_path}")

    model_info = agent_info.get("model_info", {})
    model_name = model_info.get("name")
    provider = model_info.get("provider")
    full_model = f"{provider}/{model_name}" if provider and model_name else model_name

    trajectory: dict = {
        "schema_version": "ATIF-v1.7",
        "session_id": session.get("id") if session else None,
        "agent": {
            "name": agent_info.get("name", "pim"),
            "version": agent_info.get("version", "unknown"),
            "model_name": full_model,
        },
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": total_prompt if total_prompt else None,
            "total_completion_tokens": total_completion if total_completion else None,
            "total_cached_tokens": total_cached if total_cached else None,
            "total_cost_usd": total_cost if total_cost else None,
            "total_steps": len(steps),
        },
    }

    return trajectory


def find_task_dirs(path: Path) -> list[Path]:
    """Find all task directories under a given path.

    A task directory contains both agent/pim.txt and result.json.
    Handles three cases:
      - path IS a task dir
      - path is a job dir (contains task dirs as children)
      - path is a run dir (contains job dirs which contain task dirs)
    """
    if (path / "agent" / "pim.txt").exists() and (path / "result.json").exists():
        return [path]

    dirs: list[Path] = []
    for child in sorted(path.iterdir()):
        if not child.is_dir():
            continue
        if (child / "agent" / "pim.txt").exists() and (child / "result.json").exists():
            dirs.append(child)
        else:
            for grandchild in sorted(child.iterdir()):
                if not grandchild.is_dir():
                    continue
                if (grandchild / "agent" / "pim.txt").exists() and (grandchild / "result.json").exists():
                    dirs.append(grandchild)

    return dirs


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    target = Path(sys.argv[1]).resolve()
    task_dirs = find_task_dirs(target)

    if not task_dirs:
        print(f"No task directories found under {target}", file=sys.stderr)
        sys.exit(1)

    ok = 0
    fail = 0
    for td in task_dirs:
        out_path = td / "trajectory.json"
        try:
            traj = convert(td)
            out_path.write_text(json.dumps(traj, indent=2, ensure_ascii=False) + "\n")
            ok += 1
        except Exception as e:
            print(f"FAIL {td.name}: {e}", file=sys.stderr)
            fail += 1

    print(f"Converted {ok} tasks ({fail} failures)")


if __name__ == "__main__":
    main()
