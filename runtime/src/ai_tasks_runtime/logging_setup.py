from __future__ import annotations

import logging
import sys


def _level_from_str(level: str) -> int:
    raw = (level or "").strip().upper()
    if raw in ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"):
        return getattr(logging, raw)
    return logging.INFO


def configure_logging(level: str = "info") -> None:
    """Configure runtime logging in a way that's friendly to:

    - Uvicorn (we avoid clobbering its logging config)
    - PyInstaller binaries (stdout/stderr captured by the Obsidian plugin)
    """

    lvl = _level_from_str(level)

    fmt = "%(asctime)s %(levelname)s pid=%(process)d %(name)s: %(message)s"
    handler = logging.StreamHandler(sys.stderr)
    handler.setLevel(lvl)
    handler.setFormatter(logging.Formatter(fmt))
    setattr(handler, "_ai_tasks_runtime_handler", True)

    root = logging.getLogger("ai_tasks_runtime")
    root.setLevel(lvl)
    root.propagate = False
    if not any(getattr(h, "_ai_tasks_runtime_handler", False) for h in root.handlers):
        root.addHandler(handler)

    # Child loggers propagate to the parent ("ai_tasks_runtime") handler.
    for name in ("ai_tasks_runtime.codex", "ai_tasks_runtime.sessions"):
        lg = logging.getLogger(name)
        lg.setLevel(lvl)
        lg.propagate = True

