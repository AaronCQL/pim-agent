#!/usr/bin/env python3
"""Streaming JSONL filter for pim's `--print --mode json` output.

Pim's event stream is built for live-streaming UIs: each `*_delta` event
carries a `partial` snapshot of the entire conversation so far, which
makes the log balloon (~1 GB per task with Qwen3.6). For offline logging
we only need the consolidated end-of-message state.

This filter:
  - Drops `*_delta` events and their `*_start` counterparts.
  - Strips the bloated `partial` field from any event that retains it.
  - Keeps `message_end` (which has the full accumulated content + usage),
    `tool_execution_end`, `turn_end`, `agent_start`, `agent_end`, `session`.
  - Passes through non-JSON lines verbatim (errors, etc.).

Stays in lock-step with the model via line-buffered I/O.
"""
from __future__ import annotations

import json
import sys

TOP_DROP = {
    "tool_execution_start",
    "turn_start",
    "message_start",
    "text_start",
    "thinking_start",
    "toolcall_start",
    "thinking",
    "text",
    "toolCall",
    "toolcall_delta",
}

INNER_DROP_SUFFIXES = ("_delta",)
INNER_DROP_EXACT = {"thinking_start", "text_start", "toolcall_start", "toolCall"}


def main() -> None:
    out = sys.stdout
    for raw in sys.stdin:
        line = raw.rstrip("\r\n")
        if not line:
            continue
        if not line.startswith("{"):
            out.write(line + "\n")
            out.flush()
            continue
        try:
            ev = json.loads(line)
        except Exception:
            out.write(line + "\n")
            out.flush()
            continue

        t = ev.get("type", "")
        if t in TOP_DROP:
            continue

        if t == "message_update":
            inner = ev.get("assistantMessageEvent") or {}
            it = inner.get("type", "")
            if any(it.endswith(suf) for suf in INNER_DROP_SUFFIXES):
                continue
            if it in INNER_DROP_EXACT:
                continue
            inner.pop("partial", None)

        out.write(json.dumps(ev, ensure_ascii=False) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
