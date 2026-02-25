from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


AGENT_FILES = [
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "MEMORY.md",
]

MEMORY_DIRNAME = "memory"
HISTORY_DIRNAME = "history"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _now_iso_for_filename() -> str:
    # Keep it filename-safe across platforms.
    return _utc_now_iso().replace(":", "-").replace(".", "-")


_DEFAULT_TEMPLATES: Dict[str, str] = {
    "AGENTS.md": (
        "# AGENTS.md - AI Tasks Board Agent Workspace\n\n"
        "This folder is the **Agent workspace** for AI Tasks Board.\n\n"
        "If you're running the runtime locally, this is where the Agent's **Soul / Memory / Heartbeat** live.\n\n"
        "## Every Session (Recommended)\n\n"
        "1. Read `SOUL.md` — persona and boundaries\n"
        "2. Read `USER.md` — who you're helping\n"
        "3. Read `memory/YYYY-MM-DD.md` (today + yesterday) — short-term continuity\n"
        "4. (Optional) Read `MEMORY.md` — curated long-term memory\n"
        "5. Read `HEARTBEAT.md` — what background checks should run\n"
    ),
    "SOUL.md": (
        "# SOUL.md - AI Tasks Board Agent\n\n"
        "You're not a chatbot. You're a **practical execution agent** for maintaining an Obsidian task board.\n\n"
        "## Core Truths\n\n"
        "- Prefer **minimal diffs** (patch-style) over rewriting whole files.\n"
        "- Always be explicit about **what will change** (draft/before/after) before writing.\n"
        "- Preserve history: snapshot before writes when possible.\n"
        "- Be honest about confidence; if unsure, ask the user for the missing detail.\n"
        "- When matching sessions to tasks, be conservative: link only when confident; otherwise create an `Unassigned` task.\n\n"
        "## Boundaries\n\n"
        "- Never leak secrets from logs or local files.\n"
        "- Don't run destructive actions; prefer reversible operations (history snapshots, trash).\n"
        "- If an action affects external systems (posting, payments, etc.), require confirmation.\n"
    ),
    "TOOLS.md": (
        "# TOOLS.md - Local Notes\n\n"
        "Put machine-specific notes here (paths, aliases, ports, etc.).\n\n"
        "Examples:\n"
        "- Vault path:\n"
        "- Runtime URL:\n"
        "- Codex sessions dir:\n"
    ),
    "IDENTITY.md": (
        "# IDENTITY.md - Who Am I?\n\n"
        "- Name: AI Tasks Agent\n"
        "- Purpose: Maintain `Board.md`, link sessions, and keep history.\n"
        "- Vibe: Precise, minimal-diff, safe-by-default.\n"
    ),
    "USER.md": (
        "# USER.md - About Your Human\n\n"
        "Fill this in to personalize the Agent.\n\n"
        "- Name:\n"
        "- What to call them:\n"
        "- Timezone:\n"
        "- Notes:\n"
    ),
    "HEARTBEAT.md": (
        "# HEARTBEAT.md\n\n"
        "This file configures background checks for the Agent Runtime.\n\n"
        "The runtime looks for the first JSON code block in this file.\n\n"
        "```json\n"
        "{\n"
        '  "sessions": {\n'
        '    "enabled": false,\n'
        '    "source": "codex",\n'
        '    "interval_s": 30,\n'
        '    "vault_dir": "/absolute/path/to/your/vault",\n'
        '    "stable_after_s": 10,\n'
        '    "link_board": true,\n'
        '    "board_path": "Tasks/Boards/Board.md",\n'
        '    "match_mode": "ai",\n'
        '    "match_threshold": 0.18,\n'
        '    "ai_confidence_threshold": 0.65,\n'
        '    "ai_top_k": 20\n'
        "  }\n"
        "}\n"
        "```\n"
    ),
    "MEMORY.md": (
        "# MEMORY.md - Long-Term Memory (Curated)\n\n"
        "Keep distilled, durable facts here (decisions, preferences, stable context).\n"
    ),
}


@dataclass
class AgentFile:
    name: str
    path: Path
    content: str


def ensure_agent_workspace(agent_dir: Path, *, force: bool = False) -> Dict[str, str]:
    """Ensure the Agent workspace exists (files + memory folder).

    - If `force=False` (default), only missing files are created.
    - If `force=True`, existing files are overwritten after snapshotting the previous content.
    """

    agent_dir = agent_dir.expanduser().resolve()
    agent_dir.mkdir(parents=True, exist_ok=True)

    mem_dir = agent_dir / MEMORY_DIRNAME
    mem_dir.mkdir(parents=True, exist_ok=True)

    created: Dict[str, str] = {}
    for name in AGENT_FILES:
        path = agent_dir / name
        template = _DEFAULT_TEMPLATES.get(name, "")
        if not path.exists():
            path.write_text(template, encoding="utf-8")
            created[name] = "created"
            continue
        if force:
            _snapshot_file(agent_dir, path)
            path.write_text(template, encoding="utf-8")
            created[name] = "overwritten"
        else:
            created[name] = "exists"

    # Ensure README exists for memory dir (safe to keep).
    readme = mem_dir / "README.md"
    if not readme.exists():
        readme.write_text(
            "# Agent Memory (Generated)\n\n"
            "This folder is for generated, machine-local logs/state:\n\n"
            "- `YYYY-MM-DD.md` daily logs (append-only)\n"
            "- `heartbeat-state.json` last-run timestamps for heartbeat tasks\n\n"
            "This folder is intended to be **gitignored**.\n",
            encoding="utf-8",
        )
        created[f"{MEMORY_DIRNAME}/README.md"] = "created"

    return created


def _snapshot_file(agent_dir: Path, path: Path) -> Optional[Path]:
    try:
        current = path.read_text(encoding="utf-8")
    except Exception:
        return None

    hist_dir = agent_dir / HISTORY_DIRNAME
    hist_dir.mkdir(parents=True, exist_ok=True)

    ts = _now_iso_for_filename()
    stamped = f"{path.name}.{ts}"
    snap_path = hist_dir / stamped
    snap_path.write_text(current, encoding="utf-8")
    return snap_path


def _read_text(path: Path) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return None


def load_agent_files(
    agent_dir: Path,
    *,
    include: Optional[Iterable[str]] = None,
    max_chars_per_file: int = 20_000,
    max_total_chars: int = 150_000,
) -> List[AgentFile]:
    """Load selected agent files with conservative truncation."""

    agent_dir = agent_dir.expanduser().resolve()
    want = list(include) if include is not None else list(AGENT_FILES)

    out: List[AgentFile] = []
    total = 0
    for name in want:
        path = agent_dir / name
        txt = _read_text(path)
        if txt is None:
            continue

        content = txt
        if max_chars_per_file > 0 and len(content) > max_chars_per_file:
            content = content[:max_chars_per_file] + "\n\n...[truncated]...\n"

        # Enforce total cap.
        if max_total_chars > 0 and (total + len(content)) > max_total_chars:
            remaining = max(0, max_total_chars - total)
            if remaining <= 0:
                break
            content = content[:remaining] + "\n\n...[truncated]...\n"

        out.append(AgentFile(name=name, path=path, content=content))
        total += len(content)

    return out


def build_agent_context_prelude(files: List[AgentFile]) -> str:
    if not files:
        return ""

    has_soul = any(f.name.lower() == "soul.md" for f in files)
    lines: List[str] = []
    lines.append("# Agent Workspace Context")
    if has_soul:
        lines.append(
            "If SOUL.md is present, embody its persona and boundaries. Follow it unless higher-priority instructions override it."
        )
    lines.append("")
    for f in files:
        # Use names as stable headings; absolute paths are noisy in prompts.
        lines.append(f"## {f.name}")
        lines.append("")
        lines.append(f.content.rstrip())
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def daily_memory_path(agent_dir: Path, day_iso: Optional[str] = None) -> Path:
    agent_dir = agent_dir.expanduser().resolve()
    day = day_iso or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return agent_dir / MEMORY_DIRNAME / f"{day}.md"


def append_daily_memory(agent_dir: Path, text: str) -> Path:
    agent_dir = agent_dir.expanduser().resolve()
    mem_dir = agent_dir / MEMORY_DIRNAME
    mem_dir.mkdir(parents=True, exist_ok=True)
    path = daily_memory_path(agent_dir)

    ts = _utc_now_iso()
    block = f"\n## {ts}\n{text.rstrip()}\n"
    if not path.exists():
        path.write_text(f"# {path.stem}\n{block}", encoding="utf-8")
    else:
        with path.open("a", encoding="utf-8") as f:
            f.write(block)
    return path


def heartbeat_state_path(agent_dir: Path) -> Path:
    agent_dir = agent_dir.expanduser().resolve()
    return agent_dir / MEMORY_DIRNAME / "heartbeat-state.json"


def load_heartbeat_state(agent_dir: Path) -> Dict[str, int]:
    path = heartbeat_state_path(agent_dir)
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            out: Dict[str, int] = {}
            for k, v in raw.items():
                if isinstance(k, str) and isinstance(v, int):
                    out[k] = v
            return out
    except Exception:
        return {}
    return {}


def save_heartbeat_state(agent_dir: Path, state: Dict[str, int]) -> None:
    path = heartbeat_state_path(agent_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def _extract_first_code_fence(text: str, lang: str) -> Optional[str]:
    """Return the content of the first fenced code block for a given language."""

    want = f"```{lang}".lower()
    lines = text.replace("\r\n", "\n").split("\n")
    in_fence = False
    buf: List[str] = []
    for line in lines:
        s = line.strip()
        if not in_fence:
            if s.lower().startswith(want):
                in_fence = True
                buf = []
            continue
        if s.startswith("```"):
            break
        buf.append(line)
    content = "\n".join(buf).strip()
    return content if content else None


def load_heartbeat_config(agent_dir: Path) -> Optional[Dict[str, object]]:
    path = agent_dir.expanduser().resolve() / "HEARTBEAT.md"
    txt = _read_text(path)
    if not txt:
        return None
    raw = _extract_first_code_fence(txt, "json")
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None
