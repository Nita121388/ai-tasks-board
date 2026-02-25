from __future__ import annotations

import json
from typing import Optional

import typer

from ai_tasks_runtime.config import settings
from ai_tasks_runtime.codex_cli import run_codex_exec


app = typer.Typer(no_args_is_help=True)


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

