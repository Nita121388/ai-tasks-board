from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from agno.agent import Agent

from ai_tasks_runtime.agno_models.codex_cli_model import CodexCLIModel
from ai_tasks_runtime.config import settings


@dataclass(frozen=True)
class AgentRunResult:
    text: str
    thread_id: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None
    provider_data: Optional[Dict[str, Any]] = None


def build_codex_cli_agent(*, timeout_s: int = 120, cwd: Optional[Path] = None) -> Agent:
    """Build an Agno Agent backed by local Codex CLI.

    This is the "Agno-native" execution path for AI Tasks Board. It keeps the model provider
    swappable (Codex/DeepSeek/Kimi/...) while keeping higher-level logic in the runtime.
    """

    model = CodexCLIModel(
        id="codex-cli",
        name="codex-cli",
        provider="codex-cli",
        codex_bin=settings.codex_bin,
        codex_args=settings.codex_default_args,
        codex_cwd=cwd if cwd is not None else settings.codex_cwd,
        timeout_s=timeout_s,
    )

    # parse_response=False: we handle strict JSON parsing ourselves for now.
    # telemetry=False: avoid any unexpected external calls from the library.
    return Agent(
        model=model,
        name="ai-tasks-agent",
        parse_response=False,
        markdown=False,
        telemetry=False,
    )


def run_agent_text(prompt: str, *, timeout_s: int = 120, cwd: Optional[Path] = None) -> AgentRunResult:
    agent = build_codex_cli_agent(timeout_s=timeout_s, cwd=cwd)
    out = agent.run(prompt)

    text = out.get_content_as_string()
    provider_data = out.model_provider_data or None
    thread_id: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None
    if isinstance(provider_data, dict):
        if isinstance(provider_data.get("thread_id"), str):
            thread_id = provider_data.get("thread_id")
        if isinstance(provider_data.get("usage"), dict):
            usage = provider_data.get("usage")

    return AgentRunResult(text=text, thread_id=thread_id, usage=usage, provider_data=provider_data)

