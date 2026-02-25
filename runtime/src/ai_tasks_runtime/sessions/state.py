from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


STATE_DIRNAME = ".ai-tasks"
STATE_FILENAME = "sessions-state.json"
STATE_SCHEMA = "ai-tasks-sessions-state/v1"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class SessionsState:
    schema: str = STATE_SCHEMA
    initialized_at: str = field(default_factory=_utc_now_iso)
    ignore_before_epoch: int = field(default_factory=lambda: int(time.time()))
    sources: Dict[str, Any] = field(default_factory=dict)


def state_path(vault_dir: Path) -> Path:
    return vault_dir / STATE_DIRNAME / STATE_FILENAME


def load_sessions_state(vault_dir: Path) -> Optional[SessionsState]:
    path = state_path(vault_dir)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return SessionsState(
        schema=str(data.get("schema") or STATE_SCHEMA),
        initialized_at=str(data.get("initialized_at") or _utc_now_iso()),
        ignore_before_epoch=int(data.get("ignore_before_epoch") or int(time.time())),
        sources=dict(data.get("sources") or {}),
    )


def save_sessions_state(vault_dir: Path, state: SessionsState) -> None:
    path = state_path(vault_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(asdict(state), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def ensure_sessions_state(vault_dir: Path, *, force: bool = False) -> SessionsState:
    existing = load_sessions_state(vault_dir)
    if existing and not force:
        return existing
    state = SessionsState()
    save_sessions_state(vault_dir, state)
    return state

