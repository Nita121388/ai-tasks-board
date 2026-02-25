from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from ai_tasks_runtime.config import settings
from ai_tasks_runtime.codex_cli import run_codex_exec


app = FastAPI(title="AI Tasks Runtime", version="0.0.0")


class CodexExecRequest(BaseModel):
    prompt: str
    timeout_s: int = 120
    cwd: Optional[str] = None


class CodexExecResponse(BaseModel):
    text: str
    thread_id: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None


@app.get("/v1/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "ai-tasks-runtime", "version": "0.0.0"}


@app.post("/v1/codex/exec", response_model=CodexExecResponse)
def codex_exec(req: CodexExecRequest) -> CodexExecResponse:
    cwd: Optional[Path] = None
    if req.cwd:
        cwd = Path(req.cwd).expanduser().resolve()
    elif settings.codex_cwd is not None:
        cwd = settings.codex_cwd

    result = run_codex_exec(
        req.prompt,
        codex_bin=settings.codex_bin,
        args=settings.codex_default_args,
        cwd=cwd,
        timeout_s=req.timeout_s,
    )
    return CodexExecResponse(text=result.text, thread_id=result.thread_id, usage=result.usage)

