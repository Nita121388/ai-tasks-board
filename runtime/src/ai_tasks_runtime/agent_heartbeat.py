from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, Optional

from ai_tasks_runtime.agent_workspace import (
    append_daily_memory,
    load_heartbeat_config,
    load_heartbeat_state,
    save_heartbeat_state,
)
from ai_tasks_runtime.sessions import ensure_sessions_state, load_sessions_state, sync_codex_sessions


def _as_bool(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    return default


def _as_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except Exception:
        return default


def _as_float(v: Any, default: float) -> float:
    try:
        return float(v)
    except Exception:
        return default


def _as_str(v: Any, default: str = "") -> str:
    return v if isinstance(v, str) else default


def run_heartbeat_once(agent_dir: Path) -> Dict[str, Any]:
    """Run one heartbeat tick based on `agent/HEARTBEAT.md` JSON config."""

    cfg = load_heartbeat_config(agent_dir)
    if not cfg:
        return {"ok": True, "skipped": "no_config"}

    now = int(time.time())
    state = load_heartbeat_state(agent_dir)

    result: Dict[str, Any] = {"ok": True, "ts": now, "ran": []}

    sessions_cfg = cfg.get("sessions") if isinstance(cfg.get("sessions"), dict) else None
    if sessions_cfg is not None:
        enabled = _as_bool(sessions_cfg.get("enabled"), False)
        interval_s = _as_int(sessions_cfg.get("interval_s"), 30)
        last = int(state.get("sessions_last_run", 0) or 0)
        due = enabled and (last == 0 or (now - last) >= max(1, interval_s))

        if enabled and not due:
            result["sessions"] = {"enabled": True, "due": False, "next_in_s": max(0, interval_s - (now - last))}
        elif enabled and due:
            vault_dir = Path(_as_str(sessions_cfg.get("vault_dir"), "")).expanduser().resolve()
            if not vault_dir.exists():
                result["sessions"] = {"enabled": True, "due": True, "error": f"vault_dir not found: {vault_dir}"}
            else:
                summarize = _as_bool(sessions_cfg.get("summarize"), True)
                stable_after_s = _as_int(sessions_cfg.get("stable_after_s"), 10)
                codex_sessions_dir_raw = _as_str(sessions_cfg.get("codex_sessions_dir"), "")
                codex_sessions_dir = (
                    Path(codex_sessions_dir_raw).expanduser().resolve() if codex_sessions_dir_raw.strip() else None
                )

                link_board = _as_bool(sessions_cfg.get("link_board"), True)
                board_path = _as_str(sessions_cfg.get("board_path"), "Tasks/Boards/Board.md")
                match_threshold = _as_float(sessions_cfg.get("match_threshold"), 0.18)
                match_mode = _as_str(sessions_cfg.get("match_mode"), "hybrid").strip().lower() or "hybrid"
                ai_confidence_threshold = _as_float(sessions_cfg.get("ai_confidence_threshold"), 0.65)
                ai_top_k = _as_int(sessions_cfg.get("ai_top_k"), 20)

                sess_state = load_sessions_state(vault_dir) or ensure_sessions_state(vault_dir)
                sync_result = sync_codex_sessions(
                    vault_dir=vault_dir,
                    state=sess_state,
                    sessions_root=codex_sessions_dir,
                    summarize=summarize,
                    stable_after_s=stable_after_s,
                    link_board=link_board,
                    board_rel_path=board_path,
                    match_mode=match_mode,
                    match_threshold=match_threshold,
                    ai_confidence_threshold=ai_confidence_threshold,
                    ai_top_k=ai_top_k,
                )

                state["sessions_last_run"] = now
                save_heartbeat_state(agent_dir, state)

                result["ran"].append("sessions")
                result["sessions"] = {"enabled": True, "due": True, **sync_result}

                append_daily_memory(
                    agent_dir,
                    "\n".join(
                        [
                            "Heartbeat: sessions sync",
                            f"- vault: {vault_dir}",
                            f"- written: {sync_result.get('written')}",
                            f"- linked_updates: {sync_result.get('linked_updates')}",
                            f"- created_unassigned: {sync_result.get('created_unassigned')}",
                            f"- errors: {sync_result.get('errors')}",
                        ]
                    ),
                )

    return result
