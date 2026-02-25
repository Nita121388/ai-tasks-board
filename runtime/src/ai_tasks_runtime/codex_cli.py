from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class CodexExecResult:
    text: str
    usage: Optional[Dict[str, Any]] = None
    thread_id: Optional[str] = None
    raw_events: Optional[List[Dict[str, Any]]] = None


def _iter_jsonl_lines(stdout: str) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            # Ignore non-JSONL lines defensively.
            continue
    return events


def run_codex_exec(
    prompt: str,
    *,
    codex_bin: str = "codex",
    args: Optional[List[str]] = None,
    cwd: Optional[Path] = None,
    timeout_s: int = 120,
) -> CodexExecResult:
    """Run `codex exec --json` and return the last agent_message text.

    Notes:
    - We pass the prompt via stdin (use `-` as PROMPT) to avoid shell escaping issues.
    - This is intentionally non-interactive; if Codex requests human approvals, the call must fail.
    """

    if args is None:
        raise ValueError("args must be provided (include `exec --json ... -`)")

    proc = subprocess.run(
        [codex_bin, *args],
        input=prompt.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(cwd) if cwd is not None else None,
        timeout=timeout_s,
        check=False,
    )

    stdout = proc.stdout.decode("utf-8", errors="replace")
    stderr = proc.stderr.decode("utf-8", errors="replace")
    events = _iter_jsonl_lines(stdout)

    if proc.returncode != 0:
        raise RuntimeError(f"codex exec failed (code={proc.returncode}). stderr={stderr.strip()}")

    thread_id: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None
    last_text: Optional[str] = None

    for ev in events:
        if ev.get("type") == "thread.started":
            thread_id = ev.get("thread_id")
        if ev.get("type") == "turn.completed":
            usage = ev.get("usage")
        if ev.get("type") == "item.completed":
            item = ev.get("item") or {}
            if item.get("type") == "agent_message":
                last_text = item.get("text")

    if last_text is None:
        # Helpful debug surface: include last few events.
        tail = events[-10:] if len(events) > 10 else events
        raise RuntimeError(f"codex exec produced no agent_message. tail_events={tail!r}")

    return CodexExecResult(text=last_text, usage=usage, thread_id=thread_id, raw_events=events)

