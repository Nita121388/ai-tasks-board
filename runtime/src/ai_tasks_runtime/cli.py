from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

import typer

from ai_tasks_runtime.config import settings
from ai_tasks_runtime.codex_cli import run_codex_exec
from ai_tasks_runtime.sessions import ensure_sessions_state, load_sessions_state, sync_codex_sessions


app = typer.Typer(no_args_is_help=True)
sessions_app = typer.Typer(no_args_is_help=True)
app.add_typer(sessions_app, name="sessions")


@app.command()
def serve(host: Optional[str] = None, port: Optional[int] = None) -> None:
    """Run the local HTTP runtime."""
    import uvicorn

    uvicorn.run(
        "ai_tasks_runtime.app:app",
        host=host or settings.host,
        port=port or settings.port,
        reload=False,
        log_level="info",
    )


@app.command()
def codex(prompt: str) -> None:
    """Quick smoke test for Codex CLI integration."""
    result = run_codex_exec(prompt, codex_bin=settings.codex_bin, args=settings.codex_default_args, cwd=settings.codex_cwd)
    typer.echo(result.text)
    if result.usage:
        typer.echo(json.dumps(result.usage, ensure_ascii=False))


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
    match_threshold: float = 0.18,
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
        match_threshold=match_threshold,
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
    match_threshold: float = 0.18,
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
            match_threshold=match_threshold,
        )
        typer.echo(json.dumps({"ts": time.time(), "source": "codex", **result}, ensure_ascii=False))
        time.sleep(max(1, interval_s))
