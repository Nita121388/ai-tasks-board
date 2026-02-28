from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import typer

from ai_tasks_runtime import __version__
from ai_tasks_runtime.agent_heartbeat import run_heartbeat_once
from ai_tasks_runtime.agent_workspace import (
    AgentFile,
    append_daily_memory,
    build_agent_context_prelude,
    ensure_agent_workspace,
    load_agent_files,
)
from ai_tasks_runtime.agno_agent import run_agent_text
from ai_tasks_runtime.config import settings
from ai_tasks_runtime.codex_cli import run_codex_exec
from ai_tasks_runtime.logging_setup import configure_logging
from ai_tasks_runtime.prompts import render_prompt
from ai_tasks_runtime.sessions import ensure_sessions_state, load_sessions_state, sync_codex_sessions
from ai_tasks_runtime.tools.board_toolkit import BoardToolkit


configure_logging(settings.log_level)
logger = logging.getLogger("ai_tasks_runtime")

app = typer.Typer(no_args_is_help=True)
sessions_app = typer.Typer(no_args_is_help=True)
app.add_typer(sessions_app, name="sessions")
agent_app = typer.Typer(no_args_is_help=True)
app.add_typer(agent_app, name="agent")
board_app = typer.Typer(no_args_is_help=True)
app.add_typer(board_app, name="board")


@app.command()
def serve(host: Optional[str] = None, port: Optional[int] = None) -> None:
    """Run the local HTTP runtime."""
    import uvicorn

    logger.info(
        "runtime serve start version=%s host=%s port=%s agent_dir=%s codex_bin=%s log_level=%s",
        __version__,
        host or settings.host,
        port or settings.port,
        str(settings.agent_dir),
        settings.codex_bin,
        settings.log_level,
    )

    uvicorn.run(
        "ai_tasks_runtime.app:app",
        host=host or settings.host,
        port=port or settings.port,
        reload=False,
        log_level=settings.log_level,
    )


@app.command()
def codex(prompt: str) -> None:
    """Quick smoke test for Codex CLI integration."""
    result = run_codex_exec(prompt, codex_bin=settings.codex_bin, args=settings.codex_default_args, cwd=settings.codex_cwd)
    typer.echo(result.text)
    if result.usage:
        typer.echo(json.dumps(result.usage, ensure_ascii=False))


def _read_recent_daily_memory(agent_dir: Path, days: int = 2, max_chars: int = 20_000) -> list[AgentFile]:
    out: list[AgentFile] = []
    today = datetime.now(timezone.utc).date()
    for i in range(max(0, days)):
        day = today - timedelta(days=i)
        name = f"memory/{day.isoformat()}.md"
        path = agent_dir / "memory" / f"{day.isoformat()}.md"
        if not path.exists():
            continue
        try:
            txt = path.read_text(encoding="utf-8")
        except Exception:
            continue
        content = txt
        if max_chars > 0 and len(content) > max_chars:
            content = content[:max_chars] + "\n\n...[truncated]...\n"
        out.append(AgentFile(name=name, path=path, content=content))
    return out


@agent_app.command("init")
def agent_init(agent_dir: Optional[str] = None, force: bool = False) -> None:
    """Create missing Agent workspace files (SOUL.md, MEMORY.md, HEARTBEAT.md, etc.)."""
    dir_path = Path(agent_dir).expanduser().resolve() if agent_dir else settings.agent_dir
    created = ensure_agent_workspace(dir_path, force=force)
    typer.echo(json.dumps({"ok": True, "agent_dir": str(dir_path), "files": created}, ensure_ascii=False))


@agent_app.command("ask")
def agent_ask(
    prompt: str,
    agent_dir: Optional[str] = None,
    include_memory: bool = True,
    timeout_s: int = 120,
) -> None:
    """Ask the Agent (Codex CLI) with SOUL/USER/MEMORY context injected."""
    dir_path = Path(agent_dir).expanduser().resolve() if agent_dir else settings.agent_dir
    ensure_agent_workspace(dir_path, force=False)

    include = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md"]
    if include_memory:
        include.append("MEMORY.md")
    files = load_agent_files(dir_path, include=include)
    if include_memory:
        files.extend(_read_recent_daily_memory(dir_path, days=2))

    prelude = build_agent_context_prelude(files)
    full_prompt = render_prompt(
        dir_path,
        "agent.ask.v1",
        {
            "prelude": prelude.rstrip(),
            "task": prompt.strip(),
        },
    ).lstrip()

    result = run_agent_text(full_prompt, timeout_s=timeout_s, cwd=settings.codex_cwd)

    typer.echo(result.text)

    # Keep logs bounded.
    resp_snip = (result.text or "").strip()
    if len(resp_snip) > 1200:
        resp_snip = resp_snip[:1200] + "\n...[truncated]..."
    append_daily_memory(dir_path, f"Agent ask\n\nUser:\n{prompt.strip()}\n\nAssistant:\n{resp_snip}")


@agent_app.command("heartbeat")
def agent_heartbeat(agent_dir: Optional[str] = None, watch: bool = False, poll_s: int = 5) -> None:
    """Run background heartbeat tasks configured in HEARTBEAT.md."""
    dir_path = Path(agent_dir).expanduser().resolve() if agent_dir else settings.agent_dir
    ensure_agent_workspace(dir_path, force=False)

    if not watch:
        typer.echo(json.dumps(run_heartbeat_once(dir_path), ensure_ascii=False))
        return

    typer.echo(json.dumps({"ok": True, "watching": True, "agent_dir": str(dir_path), "poll_s": poll_s}, ensure_ascii=False))
    while True:
        res = run_heartbeat_once(dir_path)
        # Only print when something actually ran (avoid noisy logs).
        if res.get("ran"):
            typer.echo(json.dumps(res, ensure_ascii=False))
        time.sleep(max(1, poll_s))


@board_app.command("apply")
def board_apply(
    vault: str,
    draft: str,
    instruction: Optional[str] = None,
    mode: str = "auto",
    board_path: str = "Tasks/Boards/Board.md",
    timeout_s: int = 120,
) -> None:
    """Agentic tool-calling: apply a draft to Board.md via Agno tools (writes the board with history snapshots)."""
    vault_dir = Path(vault).expanduser().resolve()
    if not vault_dir.exists():
        raise typer.BadParameter(f"vault does not exist: {vault_dir}")

    ensure_agent_workspace(settings.agent_dir, force=False)
    ctx_files = load_agent_files(settings.agent_dir, include=["SOUL.md", "AGENTS.md"])
    ctx = build_agent_context_prelude(ctx_files)

    instruction_block = ""
    if instruction and instruction.strip():
        instruction_block = f"Additional user instruction:\n{instruction.strip()}\n"

    prompt = render_prompt(
        settings.agent_dir,
        "board.agent.apply.v1",
        {
            "ctx": ctx,
            "mode": (mode or "auto").strip().lower(),
            "draft": (draft or "").strip(),
            "instruction_block": instruction_block,
        },
    )

    toolkit = BoardToolkit(vault_dir=vault_dir, board_rel_path=board_path)
    result = run_agent_text(prompt, timeout_s=timeout_s, cwd=settings.codex_cwd, tools=[toolkit])
    typer.echo(result.text)


@sessions_app.command("init")
def sessions_init(vault: str, force: bool = False) -> None:
    """Initialize the sessions collector state (ignore historical sessions before init)."""
    vault_dir = Path(vault).expanduser().resolve()
    if not vault_dir.exists():
        raise typer.BadParameter(f"vault does not exist: {vault_dir}")
    state = ensure_sessions_state(vault_dir, force=force)
    typer.echo(json.dumps({"ok": True, "vault": str(vault_dir), "ignore_before_epoch": state.ignore_before_epoch}, ensure_ascii=False))


@sessions_app.command("sync")
def sessions_sync(
    vault: str,
    summarize: bool = True,
    stable_after_s: int = 10,
    codex_sessions_dir: Optional[str] = None,
    link_board: bool = True,
    board_path: str = "Tasks/Boards/Board.md",
    match_mode: str = "hybrid",
    match_threshold: float = 0.18,
    ai_confidence_threshold: float = 0.65,
    ai_top_k: int = 20,
) -> None:
    """One-shot sync: write new Sessions JSON files (Mode B) into the vault."""
    vault_dir = Path(vault).expanduser().resolve()
    if not vault_dir.exists():
        raise typer.BadParameter(f"vault does not exist: {vault_dir}")

    state = load_sessions_state(vault_dir) or ensure_sessions_state(vault_dir)
    root = Path(codex_sessions_dir).expanduser().resolve() if codex_sessions_dir else None
    result = sync_codex_sessions(
        vault_dir=vault_dir,
        state=state,
        sessions_root=root,
        summarize=summarize,
        stable_after_s=stable_after_s,
        link_board=link_board,
        board_rel_path=board_path,
        match_mode=match_mode,
        match_threshold=match_threshold,
        ai_confidence_threshold=ai_confidence_threshold,
        ai_top_k=ai_top_k,
    )
    typer.echo(json.dumps({"ok": True, "source": "codex", **result}, ensure_ascii=False))


@sessions_app.command("watch")
def sessions_watch(
    vault: str,
    interval_s: int = 10,
    summarize: bool = True,
    stable_after_s: int = 10,
    codex_sessions_dir: Optional[str] = None,
    link_board: bool = True,
    board_path: str = "Tasks/Boards/Board.md",
    match_mode: str = "hybrid",
    match_threshold: float = 0.18,
    ai_confidence_threshold: float = 0.65,
    ai_top_k: int = 20,
) -> None:
    """Watch mode: poll and sync new sessions continuously."""
    vault_dir = Path(vault).expanduser().resolve()
    if not vault_dir.exists():
        raise typer.BadParameter(f"vault does not exist: {vault_dir}")

    state = load_sessions_state(vault_dir) or ensure_sessions_state(vault_dir)
    root = Path(codex_sessions_dir).expanduser().resolve() if codex_sessions_dir else None

    typer.echo(json.dumps({"ok": True, "watching": True, "interval_s": interval_s, "vault": str(vault_dir)}, ensure_ascii=False))
    while True:
        result = sync_codex_sessions(
            vault_dir=vault_dir,
            state=state,
            sessions_root=root,
            summarize=summarize,
            stable_after_s=stable_after_s,
            link_board=link_board,
            board_rel_path=board_path,
            match_mode=match_mode,
            match_threshold=match_threshold,
            ai_confidence_threshold=ai_confidence_threshold,
            ai_top_k=ai_top_k,
        )
        typer.echo(json.dumps({"ts": time.time(), "source": "codex", **result}, ensure_ascii=False))
        time.sleep(max(1, interval_s))
