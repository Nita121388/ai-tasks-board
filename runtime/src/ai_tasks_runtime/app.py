from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import FastAPI
from pydantic import BaseModel

from ai_tasks_runtime.agent_workspace import (
    append_daily_memory,
    build_agent_context_prelude,
    ensure_agent_workspace,
    load_agent_files,
)
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


class AgentAskRequest(BaseModel):
    prompt: str
    include_memory: bool = True
    record_memory: bool = True
    timeout_s: int = 120


class AgentAskResponse(BaseModel):
    text: str
    thread_id: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None


class TaskSummary(BaseModel):
    uuid: str
    title: str
    status: str
    tags: List[str] = []


class BoardProposeRequest(BaseModel):
    # "auto": decide create vs update
    # "create": always create new task
    # "update": try update; if no match, fall back to create
    mode: Literal["auto", "create", "update"] = "auto"
    draft: str
    instruction: Optional[str] = None
    tasks: List[TaskSummary] = []


class BoardProposeResponse(BaseModel):
    action: Literal["create", "update"]
    target_uuid: Optional[str] = None
    title: str
    status: str
    tags: List[str] = []
    body: str = ""
    reasoning: Optional[str] = None
    confidence: Optional[float] = None


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


@app.post("/v1/agent/ask", response_model=AgentAskResponse)
def agent_ask(req: AgentAskRequest) -> AgentAskResponse:
    """Lightweight Agent endpoint: inject SOUL/USER/MEMORY context and call Codex CLI."""

    agent_dir = settings.agent_dir
    ensure_agent_workspace(agent_dir, force=False)

    include = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md"]
    if req.include_memory:
        include.append("MEMORY.md")
    files = load_agent_files(agent_dir, include=include)
    prelude = build_agent_context_prelude(files)

    prompt = "\n".join(
        [
            prelude.rstrip(),
            "# Task",
            (req.prompt or "").strip(),
            "",
            "Return plain text only.",
        ]
    ).lstrip()

    result = run_codex_exec(
        prompt,
        codex_bin=settings.codex_bin,
        args=settings.codex_default_args,
        cwd=settings.codex_cwd,
        timeout_s=req.timeout_s,
    )

    if req.record_memory:
        text = (result.text or "").strip()
        if len(text) > 1200:
            text = text[:1200] + "\n...[truncated]..."
        append_daily_memory(agent_dir, f"Agent ask (HTTP)\n\nUser:\n{(req.prompt or '').strip()}\n\nAssistant:\n{text}")

    return AgentAskResponse(text=result.text, thread_id=result.thread_id, usage=result.usage)


def _first_non_empty_line(text: str) -> str:
    for line in text.splitlines():
        t = line.strip()
        if t:
            return t
    return ""


def _extract_tags(text: str) -> List[str]:
    # Simple heuristics:
    # - hashtags like #tag or #tag-name
    # - "tags: a, b" / "tags:: a, b"
    tags: List[str] = []
    for m in re.finditer(r"(?<!\\w)#([A-Za-z0-9_\\-\\u4e00-\\u9fff]{1,32})", text):
        tags.append(m.group(1))

    for line in text.splitlines():
        mm = re.match(r"^\\s*tags\\s*[:：]{1,2}\\s*(.+)\\s*$", line, flags=re.IGNORECASE)
        if not mm:
            continue
        raw = mm.group(1)
        for part in re.split(r"[,，]", raw):
            p = part.strip()
            if p:
                tags.append(p.lstrip("#"))

    # Dedup while preserving order.
    out: List[str] = []
    seen = set()
    for t in tags:
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


def _tokenize(s: str) -> List[str]:
    # Lowercase word-ish tokens; keep CJK chunks too.
    return re.findall(r"[A-Za-z0-9_\\-]{2,}|[\\u4e00-\\u9fff]{1,}", s.lower())


def _best_match_task(draft: str, tasks: List[TaskSummary]) -> Tuple[Optional[TaskSummary], float]:
    tokens = set(_tokenize(draft))
    if not tokens or not tasks:
        return None, 0.0

    best: Optional[TaskSummary] = None
    best_score = 0.0
    for t in tasks:
        tt = set(_tokenize(t.title))
        if not tt:
            continue
        inter = len(tokens & tt)
        union = len(tokens | tt)
        score = inter / union if union else 0.0
        if score > best_score:
            best_score = score
            best = t
    return best, best_score


def _parse_json_obj(text: str) -> Optional[Dict[str, Any]]:
    # Find the first JSON object in text.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    snippet = text[start : end + 1]
    try:
        return json.loads(snippet)
    except Exception:
        return None


def _codex_propose(req: BoardProposeRequest) -> Optional[BoardProposeResponse]:
    # Best-effort AI proposal. If Codex CLI isn't available/configured, callers will fall back.
    tasks_json = [
        {"uuid": t.uuid, "title": t.title, "status": t.status, "tags": t.tags}
        for t in req.tasks
    ]

    agent_dir = settings.agent_dir
    try:
        ensure_agent_workspace(agent_dir, force=False)
        ctx_files = load_agent_files(agent_dir, include=["SOUL.md", "AGENTS.md"])
        ctx = build_agent_context_prelude(ctx_files)
    except Exception:
        ctx = ""

    prompt = ctx + (
        "You are helping maintain an Obsidian Markdown task board.\n"
        "Given a user draft text, decide whether to create a new task or update an existing one.\n"
        "Return ONLY valid JSON with this shape:\n"
        "{\n"
        '  "action": "create"|"update",\n'
        '  "target_uuid": string|null,\n'
        '  "title": string,\n'
        '  "status": "Unassigned"|"Todo"|"Doing"|"Review"|"Done",\n'
        '  "tags": string[],\n'
        '  "body": string,\n'
        '  "reasoning": string,\n'
        '  "confidence": number\n'
        "}\n"
        "\n"
        f"Mode hint: {req.mode}\n"
        "Existing tasks (JSON):\n"
        f"{json.dumps(tasks_json, ensure_ascii=False)}\n"
        "\n"
        "User draft:\n"
        f"{req.draft}\n"
    )
    if req.instruction:
        prompt += f"\nAdditional user instruction:\n{req.instruction}\n"

    result = run_codex_exec(
        prompt,
        codex_bin=settings.codex_bin,
        args=settings.codex_default_args,
        cwd=settings.codex_cwd,
        timeout_s=120,
    )
    obj = _parse_json_obj(result.text)
    if not obj:
        return None

    action = obj.get("action")
    if action not in ("create", "update"):
        return None

    return BoardProposeResponse(
        action=action,
        target_uuid=obj.get("target_uuid"),
        title=str(obj.get("title") or "Untitled").strip() or "Untitled",
        status=str(obj.get("status") or "Unassigned"),
        tags=list(obj.get("tags") or []),
        body=str(obj.get("body") or ""),
        reasoning=str(obj.get("reasoning") or "") or None,
        confidence=float(obj.get("confidence")) if obj.get("confidence") is not None else None,
    )


def _heuristic_propose(req: BoardProposeRequest) -> BoardProposeResponse:
    draft = (req.draft or "").strip()
    title = _first_non_empty_line(draft)[:80] or "New task"
    tags = _extract_tags(draft + "\n" + (req.instruction or ""))

    # Default status is conservative.
    status = "Unassigned"

    best, score = _best_match_task(draft, req.tasks)

    wants_create = req.mode == "create"
    wants_update = req.mode == "update"

    # Threshold: require some overlap; otherwise create.
    should_update = best is not None and score >= 0.18
    if wants_create:
        should_update = False
    if wants_update and best is None:
        should_update = False

    if should_update and best is not None:
        return BoardProposeResponse(
            action="update",
            target_uuid=best.uuid,
            title=best.title or title,
            status=best.status or status,
            tags=tags or best.tags or [],
            body=draft,
            reasoning=f"heuristic match title overlap score={score:.2f}",
            confidence=min(0.9, max(0.2, score)),
        )

    return BoardProposeResponse(
        action="create",
        target_uuid=None,
        title=title,
        status=status,
        tags=tags,
        body=draft,
        reasoning="heuristic create (no strong match)",
        confidence=0.3,
    )


@app.post("/v1/board/propose", response_model=BoardProposeResponse)
def board_propose(req: BoardProposeRequest) -> BoardProposeResponse:
    # Try AI first; fall back to deterministic heuristics.
    try:
        proposed = _codex_propose(req)
        if proposed is not None:
            # Respect caller hint: if mode=create, never return update.
            if req.mode == "create" and proposed.action == "update":
                proposed.action = "create"
                proposed.target_uuid = None
            return proposed
    except Exception:
        pass

    return _heuristic_propose(req)
