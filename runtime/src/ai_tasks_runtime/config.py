from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings.

    Keep defaults conservative: Codex CLI runs read-only by default.
    """

    model_config = SettingsConfigDict(env_prefix="AI_TASKS_", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 17890

    codex_bin: str = "codex"
    codex_default_args: List[str] = [
        "--ask-for-approval",
        "untrusted",
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


settings = Settings()

