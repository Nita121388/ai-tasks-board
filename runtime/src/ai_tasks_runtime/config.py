from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_agent_dir() -> Path:
    # Prefer the repo's `agent/` workspace when running from source.
    # Fallback to a local `./agent` folder when installed elsewhere.
    here = Path(__file__).resolve()
    candidate = here.parents[3] / "agent"
    if candidate.exists():
        return candidate
    return Path.cwd() / "agent"


class Settings(BaseSettings):
    """Runtime settings.

    Keep defaults conservative: Codex CLI runs read-only by default.
    """

    model_config = SettingsConfigDict(env_prefix="AI_TASKS_", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 17890

    # Agent workspace directory (SOUL.md, MEMORY.md, HEARTBEAT.md, etc.)
    agent_dir: Path = Field(default_factory=_default_agent_dir)

    codex_bin: str = "codex"
    codex_default_args: List[str] = [
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--color",
        "never",
        "-s",
        "read-only",
        "--skip-git-repo-check",
        "-",
    ]

    # Optional: default working directory for Codex exec calls.
    codex_cwd: Optional[Path] = None

    # Codex session logs root (Codex CLI stores rollouts as JSONL here).
    codex_sessions_dir: Path = Path.home() / ".codex" / "sessions"

    # 允许 Obsidian 桌面端通过 app:// 协议访问本地运行时
    cors_allow_origins: List[str] = [
        "app://obsidian.md",
        "http://127.0.0.1",
        "http://localhost",
    ]


settings = Settings()
