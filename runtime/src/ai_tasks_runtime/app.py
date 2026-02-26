from __future__ import annotations

import json
import logging
import os
import re
import signal
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
from pydantic import BaseModel

from ai_tasks_runtime.agent_workspace import (
    append_daily_memory,
    build_agent_context_prelude,
    ensure_agent_workspace,
    load_agent_files,
)
from ai_tasks_runtime.agno_agent import run_agent_text
from ai_tasks_runtime.config import settings
from ai_tasks_runtime.codex_cli import run_codex_exec
from ai_tasks_runtime.prompts import render_prompt
from ai_tasks_runtime.tools.board_toolkit import BoardToolkit


app = FastAPI(title="AI Tasks Runtime", version="0.0.0")
STARTED_AT = time.time()
logger = logging.getLogger("ai_tasks_runtime")

# 允许 Obsidian 桌面端调用本地运行时 API（CORS）
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


class ModelConfig(BaseModel):
    provider: Literal["codex-cli", "openai-compatible"] = "codex-cli"
    model: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    top_p: Optional[float] = None


class BoardProposeRequest(BaseModel):
    # "auto": decide create vs update
    # "create": always create new task
    # "update": try update; if no match, fall back to create
    mode: Literal["auto", "create", "update"] = "auto"
    draft: str
    instruction: Optional[str] = None
    tasks: List[TaskSummary] = []
    ai_model: Optional[ModelConfig] = None
    tag_presets: List[str] = []


class BoardProposeResponse(BaseModel):
    action: Literal["create", "update"]
    target_uuid: Optional[str] = None
    title: str
    status: str
    tags: List[str] = []
    body: str = ""
    reasoning: Optional[str] = None
    confidence: Optional[float] = None
    engine: Literal["ai", "heuristic"] = "heuristic"
    provider: Optional[str] = None
    thread_id: Optional[str] = None
    ai_fallback: Optional[str] = None


class SplitTask(BaseModel):
    title: str
    status: str = "Unassigned"
    tags: List[str] = []
    body: str = ""


class BoardSplitRequest(BaseModel):
    text: str
    instruction: Optional[str] = None
    tag_presets: List[str] = []
    max_tasks: int = 60
    ai_model: Optional[ModelConfig] = None


class BoardSplitResponse(BaseModel):
    tasks: List[SplitTask] = []
    reasoning: Optional[str] = None
    confidence: Optional[float] = None
    engine: Literal["ai", "heuristic"] = "heuristic"
    provider: Optional[str] = None
    thread_id: Optional[str] = None
    ai_fallback: Optional[str] = None


class BoardAgentApplyRequest(BaseModel):
    vault: str
    board_path: str = "Tasks/Boards/Board.md"
    mode: Literal["auto", "create", "update"] = "auto"
    draft: str
    instruction: Optional[str] = None
    timeout_s: int = 120


class BoardAgentApplyResponse(BaseModel):
    text: str
    thread_id: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None


class RuntimeShutdownRequest(BaseModel):
    force: bool = False


@app.get("/v1/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "ai-tasks-runtime", "version": "0.0.0"}


@app.get("/v1/runtime/status")
def runtime_status() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "ai-tasks-runtime",
        "version": "0.0.0",
        "pid": os.getpid(),
        "uptime_s": max(0.0, time.time() - STARTED_AT),
    }


@app.post("/v1/runtime/shutdown")
def runtime_shutdown(req: RuntimeShutdownRequest) -> Dict[str, Any]:
    def _do_shutdown() -> None:
        try:
            if req.force:
                os._exit(0)
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception:
            os._exit(0)

    threading.Timer(0.2, _do_shutdown).start()
    return {"ok": True, "pid": os.getpid()}


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

    prompt = render_prompt(
        agent_dir,
        "agent.ask.v1",
        {
            "prelude": prelude.rstrip(),
            "task": (req.prompt or "").strip(),
        },
    ).lstrip()

    result = run_agent_text(prompt, timeout_s=req.timeout_s, cwd=settings.codex_cwd)

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


def _normalize_model_config(req: BoardProposeRequest) -> ModelConfig:
    return req.ai_model or ModelConfig()


def _normalize_split_tasks(tasks_raw: Any, *, max_tasks: int) -> List[SplitTask]:
    if not isinstance(tasks_raw, list):
        return []

    out: List[SplitTask] = []
    for item in tasks_raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        status = str(item.get("status") or "Unassigned").strip() or "Unassigned"

        tags_raw = item.get("tags") or []
        tags: List[str] = []
        if isinstance(tags_raw, list):
            for t in tags_raw:
                tt = str(t).strip()
                if tt:
                    tags.append(tt)
        body = str(item.get("body") or "")

        out.append(SplitTask(title=title[:200], status=status, tags=tags, body=body))
        if len(out) >= max(1, int(max_tasks or 60)):
            break
    return out


def _openai_url(base_url: Optional[str]) -> str:
    root = (base_url or "https://api.openai.com").rstrip("/")
    if root.endswith("/v1"):
        return f"{root}/chat/completions"
    return f"{root}/v1/chat/completions"


def _openai_compat_propose(req: BoardProposeRequest, cfg: ModelConfig) -> Optional[BoardProposeResponse]:
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

    instruction_block = ""
    if req.instruction and req.instruction.strip():
        instruction_block = f"Additional user instruction:\\n{req.instruction.strip()}\\n"

    prompt = render_prompt(
        agent_dir,
        "board.propose.v1",
        {
            "ctx": ctx,
            "mode": req.mode,
            "tasks_json": json.dumps(tasks_json, ensure_ascii=False),
            "tag_presets_json": json.dumps(req.tag_presets or [], ensure_ascii=False),
            "draft": req.draft,
            "instruction_block": instruction_block,
        },
    )

    url = _openai_url(cfg.base_url)
    headers = {"Content-Type": "application/json"}
    if cfg.api_key and cfg.api_key.strip():
        headers["Authorization"] = f"Bearer {cfg.api_key.strip()}"

    payload: Dict[str, Any] = {
        "model": cfg.model or "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
    }
    if cfg.temperature is not None:
        payload["temperature"] = cfg.temperature
    if cfg.top_p is not None:
        payload["top_p"] = cfg.top_p
    if cfg.max_tokens is not None and cfg.max_tokens > 0:
        payload["max_tokens"] = cfg.max_tokens

    resp = httpx.post(url, json=payload, headers=headers, timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError(f"openai-compatible call failed: {resp.status_code} {resp.text}")

    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        return None
    msg = choices[0].get("message") or {}
    text = msg.get("content") or ""
    if not isinstance(text, str) or not text.strip():
        return None

    obj = _parse_json_obj(text)
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
        engine="ai",
        provider="openai-compatible",
    )


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

    instruction_block = ""
    if req.instruction and req.instruction.strip():
        instruction_block = f"Additional user instruction:\n{req.instruction.strip()}\n"

    prompt = render_prompt(
        agent_dir,
        "board.propose.v1",
        {
            "ctx": ctx,
            "mode": req.mode,
            "tasks_json": json.dumps(tasks_json, ensure_ascii=False),
            "tag_presets_json": json.dumps(req.tag_presets or [], ensure_ascii=False),
            "draft": req.draft,
            "instruction_block": instruction_block,
        },
    )

    result = run_agent_text(prompt, timeout_s=120, cwd=settings.codex_cwd)
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
        engine="ai",
        provider="codex-cli",
        thread_id=result.thread_id,
    )


def _openai_compat_split(req: BoardSplitRequest, cfg: ModelConfig) -> Optional[BoardSplitResponse]:
    agent_dir = settings.agent_dir
    try:
        ensure_agent_workspace(agent_dir, force=False)
        ctx_files = load_agent_files(agent_dir, include=["SOUL.md", "AGENTS.md"])
        ctx = build_agent_context_prelude(ctx_files)
    except Exception:
        ctx = ""

    instruction_block = ""
    if req.instruction and req.instruction.strip():
        instruction_block = f"Additional user instruction:\\n{req.instruction.strip()}\\n"

    prompt = render_prompt(
        agent_dir,
        "board.split.v1",
        {
            "ctx": ctx,
            "tag_presets_json": json.dumps(req.tag_presets or [], ensure_ascii=False),
            "max_tasks": str(int(req.max_tasks or 60)),
            "text": req.text,
            "instruction_block": instruction_block,
        },
    )

    url = _openai_url(cfg.base_url)
    headers = {"Content-Type": "application/json"}
    if cfg.api_key and cfg.api_key.strip():
        headers["Authorization"] = f"Bearer {cfg.api_key.strip()}"

    payload: Dict[str, Any] = {
        "model": cfg.model or "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
    }
    if cfg.temperature is not None:
        payload["temperature"] = cfg.temperature
    if cfg.top_p is not None:
        payload["top_p"] = cfg.top_p
    if cfg.max_tokens is not None and cfg.max_tokens > 0:
        payload["max_tokens"] = cfg.max_tokens

    resp = httpx.post(url, json=payload, headers=headers, timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError(f"openai-compatible call failed: {resp.status_code} {resp.text}")

    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        return None
    msg = choices[0].get("message") or {}
    text = msg.get("content") or ""
    if not isinstance(text, str) or not text.strip():
        return None

    obj = _parse_json_obj(text)
    if not obj:
        return None

    tasks = _normalize_split_tasks(obj.get("tasks"), max_tasks=req.max_tasks)
    if not tasks:
        return None

    confidence: Optional[float] = None
    if obj.get("confidence") is not None:
        try:
            confidence = float(obj.get("confidence"))
        except Exception:
            confidence = None

    return BoardSplitResponse(
        tasks=tasks,
        reasoning=str(obj.get("reasoning") or "") or None,
        confidence=confidence,
        engine="ai",
        provider="openai-compatible",
    )


def _codex_split(req: BoardSplitRequest) -> Optional[BoardSplitResponse]:
    agent_dir = settings.agent_dir
    try:
        ensure_agent_workspace(agent_dir, force=False)
        ctx_files = load_agent_files(agent_dir, include=["SOUL.md", "AGENTS.md"])
        ctx = build_agent_context_prelude(ctx_files)
    except Exception:
        ctx = ""

    instruction_block = ""
    if req.instruction and req.instruction.strip():
        instruction_block = f"Additional user instruction:\n{req.instruction.strip()}\n"

    prompt = render_prompt(
        agent_dir,
        "board.split.v1",
        {
            "ctx": ctx,
            "tag_presets_json": json.dumps(req.tag_presets or [], ensure_ascii=False),
            "max_tasks": str(int(req.max_tasks or 60)),
            "text": req.text,
            "instruction_block": instruction_block,
        },
    )

    result = run_agent_text(prompt, timeout_s=120, cwd=settings.codex_cwd)
    obj = _parse_json_obj(result.text)
    if not obj:
        return None

    tasks = _normalize_split_tasks(obj.get("tasks"), max_tasks=req.max_tasks)
    if not tasks:
        return None

    confidence: Optional[float] = None
    if obj.get("confidence") is not None:
        try:
            confidence = float(obj.get("confidence"))
        except Exception:
            confidence = None

    return BoardSplitResponse(
        tasks=tasks,
        reasoning=str(obj.get("reasoning") or "") or None,
        confidence=confidence,
        engine="ai",
        provider="codex-cli",
        thread_id=result.thread_id,
    )


def _heuristic_split(req: BoardSplitRequest) -> BoardSplitResponse:
    text = (req.text or "").replace("\r\n", "\n").strip()
    if not text:
        return BoardSplitResponse(tasks=[], reasoning="empty input", confidence=0.0, engine="heuristic")

    # Insert newlines before numbered markers to make single-line lists split-able.
    text = re.sub(r"\s+(?=\d{1,2}[.)、]\s+)", "\n", text)

    presets = [t.strip() for t in (req.tag_presets or []) if isinstance(t, str) and t.strip()]
    presets_lower = {t.lower(): t for t in presets}

    current_tags: List[str] = []
    tasks: List[SplitTask] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Drop simple leading numbering like "1.", "2)".
        line = re.sub(r"^\d{1,3}[.)、]\s*", "", line).strip()
        if not line:
            continue

        # Treat a line as a "section tag" when it matches a preset and is short.
        key = line.lower()
        if key in presets_lower and len(line) <= 32 and not re.search(r"[:：=>]", line):
            current_tags = [presets_lower[key]]
            continue

        title = line.split("=>", 1)[0].strip() or line.strip()
        if not title:
            continue

        tags = list(current_tags)
        for p in presets:
            if p.lower() in title.lower() and p not in tags:
                tags.append(p)

        tasks.append(SplitTask(title=title[:200], status="Unassigned", tags=tags, body=""))
        if len(tasks) >= max(1, int(req.max_tasks or 60)):
            break

    return BoardSplitResponse(
        tasks=tasks,
        reasoning="heuristic split by numbering/lines",
        confidence=0.2,
        engine="heuristic",
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
            engine="heuristic",
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
        engine="heuristic",
    )


@app.post("/v1/board/propose", response_model=BoardProposeResponse)
def board_propose(req: BoardProposeRequest) -> BoardProposeResponse:
    # Try AI first; fall back to deterministic heuristics.
    cfg = _normalize_model_config(req)
    ai_fallback: Optional[str] = None
    try:
        if cfg.provider == "openai-compatible":
            proposed = _openai_compat_propose(req, cfg)
        else:
            proposed = _codex_propose(req)
        if proposed is not None:
            # Respect caller hint: if mode=create, never return update.
            if req.mode == "create" and proposed.action == "update":
                proposed.action = "create"
                proposed.target_uuid = None
            return proposed
    except Exception as exc:
        ai_fallback = f"exception:{type(exc).__name__}"
        logger.exception("board_propose failed; falling back to heuristic", exc_info=exc)
    else:
        ai_fallback = "no_valid_json"

    out = _heuristic_propose(req)
    out.ai_fallback = ai_fallback
    out.provider = cfg.provider
    return out


@app.post("/v1/board/split", response_model=BoardSplitResponse)
def board_split(req: BoardSplitRequest) -> BoardSplitResponse:
    cfg = req.ai_model or ModelConfig()
    ai_fallback: Optional[str] = None

    try:
        if cfg.provider == "openai-compatible":
            proposed = _openai_compat_split(req, cfg)
        else:
            proposed = _codex_split(req)
        if proposed is not None:
            return proposed
    except Exception as exc:
        ai_fallback = f"exception:{type(exc).__name__}"
        logger.exception("board_split failed; falling back to heuristic", exc_info=exc)
    else:
        ai_fallback = "no_valid_json"

    out = _heuristic_split(req)
    out.ai_fallback = ai_fallback
    out.provider = cfg.provider
    return out


@app.post("/v1/board/agent/apply", response_model=BoardAgentApplyResponse)
def board_agent_apply(req: BoardAgentApplyRequest) -> BoardAgentApplyResponse:
    """Agentic tool-calling flow: apply a draft to Board.md via BoardToolkit tools.

    This endpoint writes to the vault on disk and snapshots history before modifications.
    """

    vault_dir = Path(req.vault).expanduser().resolve()
    if not vault_dir.exists():
        raise HTTPException(status_code=400, detail=f"vault does not exist: {vault_dir}")

    agent_dir = settings.agent_dir
    ensure_agent_workspace(agent_dir, force=False)
    ctx_files = load_agent_files(agent_dir, include=["SOUL.md", "AGENTS.md"])
    ctx = build_agent_context_prelude(ctx_files)

    instruction_block = ""
    if req.instruction and req.instruction.strip():
        instruction_block = f"Additional user instruction:\n{req.instruction.strip()}\n"

    prompt = render_prompt(
        agent_dir,
        "board.agent.apply.v1",
        {
            "ctx": ctx,
            "mode": req.mode,
            "draft": (req.draft or "").strip(),
            "instruction_block": instruction_block,
        },
    )

    toolkit = BoardToolkit(vault_dir=vault_dir, board_rel_path=req.board_path)
    result = run_agent_text(prompt, timeout_s=req.timeout_s, cwd=settings.codex_cwd, tools=[toolkit])
    return BoardAgentApplyResponse(text=result.text, thread_id=result.thread_id, usage=result.usage)
