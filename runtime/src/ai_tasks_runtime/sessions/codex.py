from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from ai_tasks_runtime.agent_workspace import build_agent_context_prelude, ensure_agent_workspace, load_agent_files
from ai_tasks_runtime.agno_agent import run_agent_text
from ai_tasks_runtime.board_md import (
    add_session_ref_to_block,
    build_task_block,
    ensure_board_file,
    insert_task_block,
    parse_board,
    replace_task_block,
    write_board_with_history,
)
from ai_tasks_runtime.config import settings
from ai_tasks_runtime.prompts import render_prompt
from ai_tasks_runtime.sessions.state import SessionsState, save_sessions_state


logger = logging.getLogger("ai_tasks_runtime.sessions")

_UUID_IN_FILENAME_RE = re.compile(
    r"(?P<uuid>[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12})\.jsonl$"
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(ts: str) -> Optional[datetime]:
    t = (ts or "").strip()
    if not t:
        return None
    try:
        if t.endswith("Z"):
            t = t[:-1] + "+00:00"
        return datetime.fromisoformat(t)
    except Exception:
        return None


def _redact(text: str) -> str:
    # Minimal built-in redaction. This is intentionally conservative.
    patterns = [
        (re.compile(r"sk-[A-Za-z0-9]{20,}"), "sk-REDACTED"),
        (re.compile(r"ghp_[A-Za-z0-9]{20,}"), "ghp_REDACTED"),
        (re.compile(r"AIza[0-9A-Za-z\\-_]{20,}"), "AIzaREDACTED"),
    ]
    out = text
    for rx, repl in patterns:
        out = rx.sub(repl, out)
    return out


def _is_harness_context_message(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    # Common harness-injected blocks that add noise for downstream matching.
    if t.startswith("# AGENTS.md instructions"):
        return True
    if t.startswith("<environment_context>"):
        return True
    if t.startswith("Read HEARTBEAT.md"):
        return True
    if "A new session was started via /new or /reset." in t:
        return True
    return False


@dataclass
class SessionMessage:
    role: str
    ts: Optional[str]
    text: str


@dataclass
class AiModelConfig:
    """Model configuration for AI calls used in sessions summarize/match.

    This mirrors the Obsidian plugin settings:
      - provider: "codex-cli" | "openai-compatible" | "auto"
      - model/base_url/api_key: for openai-compatible chat completions
    """

    provider: str = "codex-cli"
    model: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    top_p: Optional[float] = None


def _env_str(name: str) -> Optional[str]:
    v = os.getenv(name)
    if v is None:
        return None
    s = v.strip()
    return s or None


def _env_int(name: str) -> Optional[int]:
    v = _env_str(name)
    if v is None:
        return None
    try:
        return int(v)
    except Exception:
        return None


def _env_float(name: str) -> Optional[float]:
    v = _env_str(name)
    if v is None:
        return None
    try:
        return float(v)
    except Exception:
        return None


def _normalize_ai_provider(provider: Optional[str]) -> str:
    p = (provider or "").strip().lower()
    if p in ("", "codex", "codex-cli", "codex_cli"):
        return "codex-cli"
    if p in ("openai", "openai-compatible", "openai_compatible"):
        return "openai-compatible"
    if p in ("auto",):
        return "auto"
    return "codex-cli"


def _load_ai_model_config_from_env() -> AiModelConfig:
    # Keep env names stable: Obsidian plugin injects these for sessions sync/watch.
    provider = _env_str("AI_TASKS_MODEL_PROVIDER") or "codex-cli"
    api_key = _env_str("AI_TASKS_MODEL_API_KEY") or _env_str("OPENAI_API_KEY")
    return AiModelConfig(
        provider=_normalize_ai_provider(provider),
        model=_env_str("AI_TASKS_MODEL_NAME"),
        base_url=_env_str("AI_TASKS_MODEL_BASE_URL"),
        api_key=api_key,
        temperature=_env_float("AI_TASKS_MODEL_TEMPERATURE"),
        max_tokens=_env_int("AI_TASKS_MODEL_MAX_TOKENS"),
        top_p=_env_float("AI_TASKS_MODEL_TOP_P"),
    )


def _openai_url(base_url: Optional[str]) -> str:
    root = (base_url or "https://api.openai.com").rstrip("/")
    if root.endswith("/v1"):
        return f"{root}/chat/completions"
    return f"{root}/v1/chat/completions"


def _ai_text(prompt: str, *, ai_model: AiModelConfig, timeout_s: int = 120) -> str:
    provider = _normalize_ai_provider(ai_model.provider)
    if provider == "auto":
        provider = "openai-compatible" if (ai_model.api_key or "").strip() else "codex-cli"

    if provider == "codex-cli":
        result = run_agent_text(prompt, timeout_s=timeout_s, cwd=settings.codex_cwd)
        return result.text or ""

    if provider == "openai-compatible":
        url = _openai_url(ai_model.base_url)
        headers = {"Content-Type": "application/json"}
        if ai_model.api_key and ai_model.api_key.strip():
            headers["Authorization"] = f"Bearer {ai_model.api_key.strip()}"

        payload: Dict[str, Any] = {
            "model": ai_model.model or "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
        }
        if ai_model.temperature is not None:
            payload["temperature"] = ai_model.temperature
        if ai_model.top_p is not None:
            payload["top_p"] = ai_model.top_p
        if ai_model.max_tokens is not None and ai_model.max_tokens > 0:
            payload["max_tokens"] = ai_model.max_tokens

        resp = httpx.post(url, json=payload, headers=headers, timeout=timeout_s)
        if resp.status_code >= 400:
            raise RuntimeError(f"openai-compatible call failed: {resp.status_code} {resp.text}")

        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("openai-compatible empty response: missing choices")
        msg = choices[0].get("message") or {}
        text = msg.get("content") or ""
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError("openai-compatible empty response: missing message content")
        return text

    raise ValueError(f"Unsupported ai provider: {provider}")


def _flatten_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            txt = item.get("text")
            if isinstance(txt, str) and txt:
                parts.append(txt)
        return "\n".join(parts)
    if isinstance(content, dict):
        txt = content.get("text")
        if isinstance(txt, str):
            return txt
    return ""


def _extract_session_id(path: Path) -> Optional[str]:
    m = _UUID_IN_FILENAME_RE.search(path.name)
    if not m:
        return None
    return m.group("uuid").lower()


def iter_rollout_files(sessions_root: Path) -> List[Path]:
    if not sessions_root.exists():
        return []
    # Current Codex CLI layout is sessions/YYYY/MM/DD/rollout-*.jsonl
    files = list(sessions_root.glob("*/*/*/rollout-*.jsonl"))
    if not files:
        files = list(sessions_root.rglob("rollout-*.jsonl"))
    return files


def parse_rollout_messages(path: Path) -> Tuple[Dict[str, Any], List[SessionMessage], Optional[str], Optional[str]]:
    meta: Dict[str, Any] = {}
    messages: List[SessionMessage] = []
    started_at: Optional[str] = None
    ended_at: Optional[str] = None

    with path.open("r", encoding="utf-8", errors="replace") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                # Defensive: ignore partially-written last line.
                continue

            ts = ev.get("timestamp")
            if isinstance(ts, str):
                ended_at = ts

            ev_type = ev.get("type")
            payload = ev.get("payload") or {}

            if ev_type == "session_meta" and isinstance(payload, dict):
                # Prefer meta timestamp as started_at.
                p_ts = payload.get("timestamp")
                if isinstance(p_ts, str):
                    started_at = p_ts
                meta = {
                    "id": payload.get("id"),
                    "timestamp": payload.get("timestamp"),
                    "cwd": payload.get("cwd"),
                    "originator": payload.get("originator"),
                    "cli_version": payload.get("cli_version"),
                    "source": payload.get("source"),
                    "model_provider": payload.get("model_provider"),
                }
                continue

            if ev_type != "response_item" or not isinstance(payload, dict):
                continue
            if payload.get("type") != "message":
                continue

            role = payload.get("role")
            if role not in ("user", "assistant"):
                continue

            content = payload.get("content")
            text = _flatten_message_content(content)
            if not text:
                continue

            messages.append(SessionMessage(role=role, ts=ts if isinstance(ts, str) else None, text=_redact(text)))

    # Fallbacks.
    if started_at is None:
        started_at = ended_at
    return meta, messages, started_at, ended_at


def _select_snippets(messages: List[SessionMessage], max_snippets: int = 12) -> List[Dict[str, Any]]:
    filtered = [m for m in messages if not _is_harness_context_message(m.text)]
    if not filtered:
        filtered = messages

    picked: List[SessionMessage] = []
    if len(filtered) <= max_snippets:
        picked = filtered
    else:
        tail = filtered[-max_snippets:]
        head = filtered[0]
        if head not in tail:
            picked = [head, *tail[:-1]]
        else:
            picked = tail

    out: List[Dict[str, Any]] = []
    for m in picked:
        out.append({"role": m.role, "ts": m.ts, "text": m.text})
    return out


def _summarize_with_ai(messages: List[SessionMessage], *, ai_model: AiModelConfig) -> Optional[str]:
    filtered = [m for m in messages if not _is_harness_context_message(m.text)]
    if not filtered:
        return None

    # Keep the prompt bounded.
    parts: List[str] = []
    for m in filtered[-20:]:
        parts.append(f"{m.role.upper()}:\n{m.text}\n")
    convo = "\n".join(parts)
    if len(convo) > 12000:
        convo = convo[-12000:]

    prompt = render_prompt(
        settings.agent_dir,
        "sessions.codex.summarize.v1",
        {
            "convo": convo,
        },
    )

    try:
        text = _ai_text(prompt, ai_model=ai_model, timeout_s=120)
    except Exception:
        # Allow openai-compatible configs to fall back to local Codex when misconfigured/offline.
        if _normalize_ai_provider(ai_model.provider) in ("openai-compatible", "auto"):
            try:
                text = _ai_text(prompt, ai_model=AiModelConfig(provider="codex-cli"), timeout_s=120)
            except Exception:
                return None
        else:
            return None

    summary = (text or "").strip()
    return summary or None


def _fallback_summary(messages: List[SessionMessage]) -> Optional[str]:
    filtered = [m for m in messages if m.role == "user" and not _is_harness_context_message(m.text)]
    if not filtered:
        return None
    first = filtered[0].text.strip().splitlines()[0] if filtered[0].text.strip() else ""
    return first[:120] if first else None


def _compact_title(text: Optional[str], *, fallback: str, max_len: int = 60) -> str:
    """Derive a short task title from a session summary (or other text)."""

    s = (text or "").strip()
    if not s:
        return fallback

    s = s.splitlines()[0].strip()
    s = re.sub(r"^(summary|摘要|总结|概述)\\s*[:：]\\s*", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"\\s+", " ", s).strip()
    if not s:
        return fallback

    # For Chinese, shorter titles are easier to scan in the board UI.
    effective_max = max_len
    if re.search(r"[\\u4e00-\\u9fff]", s):
        effective_max = min(effective_max, 28)

    # Prefer cutting at a natural boundary when we need to shorten.
    if len(s) > effective_max:
        for pat in (r"[。.!?！？]\\s*", r"[；;]\\s*", r"[，,、:]\\s*"):
            m = re.search(pat, s)
            if m and m.end() >= 8 and m.end() <= effective_max:
                s = s[: m.end()].strip()
                break

    if len(s) > effective_max:
        cut = max(1, effective_max - 3)
        s = s[:cut].rstrip() + "..."

    return s


def _duration_sec(started_at: Optional[str], ended_at: Optional[str]) -> Optional[int]:
    if not started_at or not ended_at:
        return None
    sdt = _parse_iso(started_at)
    edt = _parse_iso(ended_at)
    if not sdt or not edt:
        return None
    return max(0, int((edt - sdt).total_seconds()))


def _write_json_atomic(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _parse_json_obj(text: str) -> Optional[Dict[str, Any]]:
    # Find the first JSON object in text (defensive against pre/post-amble).
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    snippet = text[start : end + 1]
    try:
        obj = json.loads(snippet)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _tokenize(s: str) -> List[str]:
    """Tokenize for fuzzy matching.

    - Latin/number chunks: keep (>=2 chars)
    - CJK chunks: add overlapping bigrams so Chinese without spaces can match.
    """

    s = (s or "").lower()
    raw: List[str] = []
    raw.extend(re.findall(r"[a-z0-9_\\-]{2,}", s))
    for chunk in re.findall(r"[\\u4e00-\\u9fff]+", s):
        if len(chunk) == 1:
            raw.append(chunk)
            continue
        # Keep the full chunk when short (helps exact phrase matches).
        if len(chunk) <= 6:
            raw.append(chunk)
        raw.extend(chunk[i : i + 2] for i in range(len(chunk) - 1))

    # Dedup while preserving order.
    out: List[str] = []
    seen = set()
    for t in raw:
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def _jaccard(a_tokens: List[str], b_tokens: List[str]) -> float:
    a = set(a_tokens)
    b = set(b_tokens)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _session_text(payload: Dict[str, Any]) -> str:
    parts: List[str] = []
    summary = payload.get("summary")
    if isinstance(summary, str) and summary.strip():
        parts.append(summary.strip())
    snippets = payload.get("snippets") or []
    if isinstance(snippets, list):
        for sn in snippets[:6]:
            if not isinstance(sn, dict):
                continue
            role = sn.get("role")
            text = sn.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(f"{role}: {text.strip()}")
    return "\n".join(parts)


def _best_task_match(board_content: str, session_payload: Dict[str, Any]) -> Tuple[Optional[str], float]:
    """Heuristic match session -> task UUID."""
    parsed = parse_board(board_content)
    tasks = [t for sec in parsed.sections.values() for t in sec.tasks]
    if not tasks:
        return None, 0.0

    s_tokens = _tokenize(_session_text(session_payload))
    if not s_tokens:
        return None, 0.0

    best_uuid: Optional[str] = None
    best_score = 0.0
    for t in tasks:
        t_text = " ".join([t.title, *t.tags])
        score = _jaccard(s_tokens, _tokenize(t_text))
        if score > best_score:
            best_score = score
            best_uuid = t.uuid
    return best_uuid, best_score


def _list_task_candidates(board_content: str) -> List[Tuple[str, str, str, List[str]]]:
    """Return all tasks as candidates (uuid, title, status, tags).

    Keep a stable status-first ordering to reduce noise in the prompt.
    """
    parsed = parse_board(board_content)
    ordered: List[Tuple[str, str, str, List[str]]] = []
    seen: set[str] = set()

    for status in ("Doing", "Todo", "Review", "Unassigned", "Done"):
        sec = parsed.sections.get(status)
        if not sec:
            continue
        for t in sec.tasks:
            ordered.append((t.uuid, t.title, t.status, t.tags))
            seen.add(t.uuid)

    # Defensive: include any remaining tasks in case future schemas add sections.
    for sec in parsed.sections.values():
        for t in sec.tasks:
            if t.uuid in seen:
                continue
            ordered.append((t.uuid, t.title, t.status, t.tags))
            seen.add(t.uuid)

    return ordered


def _ai_task_match(
    *,
    candidates: List[Tuple[str, str, str, List[str]]],
    session_payload: Dict[str, Any],
    ai_model: AiModelConfig,
    ctx: Optional[str] = None,
    timeout_s: int = 120,
) -> Tuple[Optional[str], Optional[float], Optional[str]]:
    """Ask an AI model to pick a task UUID among candidates (or null)."""
    if not candidates:
        return None, None, None

    cand_json = [
        {
            "uuid": u,
            "title": title,
            "status": status,
            "tags": tags,
        }
        for (u, title, status, tags) in candidates
    ]

    final_ctx = ctx
    if final_ctx is None:
        try:
            ensure_agent_workspace(settings.agent_dir, force=False)
            files = load_agent_files(settings.agent_dir, include=["SOUL.md", "AGENTS.md"])
            final_ctx = build_agent_context_prelude(files)
        except Exception:
            final_ctx = ""
    else:
        final_ctx = final_ctx or ""

    prompt = render_prompt(
        settings.agent_dir,
        "sessions.codex.match_task.v1",
        {
            "ctx": final_ctx,
            "session_text": _session_text(session_payload),
            "candidates_json": json.dumps(cand_json, ensure_ascii=False),
        },
    )

    try:
        text = _ai_text(prompt, ai_model=ai_model, timeout_s=timeout_s)
    except Exception:
        # Allow openai-compatible configs to fall back to local Codex when misconfigured/offline.
        if _normalize_ai_provider(ai_model.provider) in ("openai-compatible", "auto"):
            try:
                text = _ai_text(prompt, ai_model=AiModelConfig(provider="codex-cli"), timeout_s=timeout_s)
            except Exception:
                return None, None, None
        else:
            return None, None, None

    obj = _parse_json_obj(text or "")
    if not obj:
        return None, None, None

    target = obj.get("target_uuid")
    target_uuid = str(target).lower() if isinstance(target, str) and target.strip() else None

    conf_val: Optional[float] = None
    try:
        if obj.get("confidence") is not None:
            conf_val = float(obj.get("confidence"))
    except Exception:
        conf_val = None

    reasoning: Optional[str] = None
    if isinstance(obj.get("reasoning"), str):
        reasoning = obj.get("reasoning").strip() or None

    allowed = {u for (u, _, _, _) in candidates}
    if target_uuid is not None and target_uuid not in allowed:
        return None, conf_val, reasoning

    return target_uuid, conf_val, reasoning


def _chunked(items: List[Tuple[str, str, str, List[str]]], size: int) -> List[List[Tuple[str, str, str, List[str]]]]:
    k = max(1, int(size or 1))
    return [items[i : i + k] for i in range(0, len(items), k)]


def _ai_match_task_uuid(
    *,
    board_content: str,
    session_payload: Dict[str, Any],
    ai_model: AiModelConfig,
    ctx: Optional[str],
    chunk_size: int,
    timeout_s: int = 120,
) -> Tuple[Optional[str], Optional[float], Optional[str]]:
    """AI-only semantic matching (no heuristic pre-filter).

    If the board is large, run a simple tournament:
      - round 1: pick best candidate per chunk
      - round 2: pick best among round-1 winners
    """

    candidates = _list_task_candidates(board_content)
    if not candidates:
        return None, None, None

    k = max(5, int(chunk_size or 20))
    if len(candidates) <= k:
        return _ai_task_match(
            candidates=candidates,
            session_payload=session_payload,
            ai_model=ai_model,
            ctx=ctx,
            timeout_s=timeout_s,
        )

    winners: Dict[str, float] = {}
    for chunk in _chunked(candidates, k):
        u, conf, _ = _ai_task_match(
            candidates=chunk,
            session_payload=session_payload,
            ai_model=ai_model,
            ctx=ctx,
            timeout_s=timeout_s,
        )
        if not u:
            continue
        score = conf if conf is not None else 0.0
        prev = winners.get(u)
        if prev is None or score > prev:
            winners[u] = score

    if not winners:
        return None, None, None

    final_candidates = [c for c in candidates if c[0] in winners]
    final_candidates.sort(key=lambda c: winners.get(c[0], 0.0), reverse=True)

    return _ai_task_match(
        candidates=final_candidates,
        session_payload=session_payload,
        ai_model=ai_model,
        ctx=ctx,
        timeout_s=timeout_s,
    )


def sync_codex_sessions(
    *,
    vault_dir: Path,
    state: SessionsState,
    sessions_root: Optional[Path] = None,
    summarize: bool = True,
    stable_after_s: int = 10,
    link_board: bool = True,
    board_rel_path: str = "Tasks/Boards/Board.md",
    match_mode: str = "ai",
    match_threshold: float = 0.18,
    ai_confidence_threshold: float = 0.65,
    ai_top_k: int = 20,
) -> Dict[str, Any]:
    """Scan Codex rollouts and write new session JSON files into the vault (Mode B)."""

    root = sessions_root or settings.codex_sessions_dir
    out_dir = vault_dir / "Tasks" / "Sessions" / "codex"
    out_dir.mkdir(parents=True, exist_ok=True)

    board_content: Optional[str] = None
    board_changed = False
    if link_board:
        try:
            board_path = ensure_board_file(vault_dir, board_rel_path)
            board_content = board_path.read_text(encoding="utf-8")
            # Validate board markers early so we don't loop-fail per session.
            parse_board(board_content)
        except Exception as exc:
            logger.warning(
                "Board parse failed; disable linking",
                extra={"board_rel_path": board_rel_path, "error": str(exc)},
            )
            link_board = False
            board_content = None

    ai_model = _load_ai_model_config_from_env()
    mode = (match_mode or "ai").strip().lower()
    if mode not in ("heuristic", "ai", "hybrid"):
        mode = "ai"

    match_ctx: Optional[str] = None
    if link_board and board_content is not None and mode in ("ai", "hybrid"):
        try:
            ensure_agent_workspace(settings.agent_dir, force=False)
            files = load_agent_files(settings.agent_dir, include=["SOUL.md", "AGENTS.md"])
            match_ctx = build_agent_context_prelude(files)
        except Exception:
            match_ctx = ""

    now = time.time()
    ignore_before = int(state.ignore_before_epoch)

    written = 0
    skipped_old = 0
    skipped_recent = 0
    skipped_existing = 0
    skipped_already_linked = 0
    linked_updates = 0
    created_unassigned = 0
    errors = 0

    for rollout in iter_rollout_files(root):
        session_id: Optional[str] = None
        try:
            st = rollout.stat()
        except Exception:
            continue

        if int(st.st_mtime) < ignore_before:
            skipped_old += 1
            continue

        if stable_after_s > 0 and (now - st.st_mtime) < stable_after_s:
            skipped_recent += 1
            continue

        session_id = _extract_session_id(rollout)
        if not session_id:
            continue

        out_path = out_dir / f"{session_id}.json"
        payload: Optional[Dict[str, Any]] = None
        if out_path.exists():
            skipped_existing += 1
            try:
                payload = json.loads(out_path.read_text(encoding="utf-8"))
            except Exception:
                payload = None

        try:
            if payload is None:
                meta, messages, started_at, ended_at = parse_rollout_messages(rollout)
                snippets = _select_snippets(messages)
                summary: Optional[str] = None
                if summarize:
                    summary = _summarize_with_ai(messages, ai_model=ai_model) or _fallback_summary(messages)

                payload = {
                    "id": f"codex:{session_id}",
                    "source": "codex",
                    "started_at": started_at,
                    "ended_at": ended_at,
                    "duration_sec": _duration_sec(started_at, ended_at),
                    "summary": summary,
                    "snippets": snippets,
                    "meta": meta,
                    "raw_ref": {
                        "path": str(rollout),
                        "mtime_epoch": int(st.st_mtime),
                        "size": int(st.st_size),
                    },
                }
                _write_json_atomic(out_path, payload)
                written += 1

            if link_board and board_content is not None:
                session_ref = f"codex:{session_id}"
                if session_ref in board_content:
                    skipped_already_linked += 1
                else:
                    match_uuid: Optional[str] = None
                    match_method: Optional[str] = None  # "ai" | "heuristic"
                    score = 0.0
                    ai_conf: Optional[float] = None

                    # 1) AI match (if enabled)
                    if mode in ("ai", "hybrid"):
                        # `ai_top_k` now acts as the per-call chunk size.
                        ai_uuid, ai_conf, _ = _ai_match_task_uuid(
                            board_content=board_content,
                            session_payload=payload,
                            ai_model=ai_model,
                            ctx=match_ctx,
                            chunk_size=ai_top_k,
                        )
                        if ai_uuid:
                            match_uuid = ai_uuid
                            match_method = "ai"

                    # 2) Heuristic fallback (if enabled AND AI didn't return a uuid)
                    if mode in ("heuristic", "hybrid") and match_uuid is None:
                        match_uuid, score = _best_task_match(board_content, payload)
                        if match_uuid:
                            match_method = "heuristic"

                    should_link = False
                    if match_uuid:
                        if match_method == "heuristic":
                            should_link = score >= match_threshold
                        else:
                            # AI mode: require confidence when present; if missing, be conservative.
                            should_link = (ai_conf if ai_conf is not None else 0.0) >= ai_confidence_threshold

                    if should_link and match_uuid:
                        parsed = parse_board(board_content)
                        existing = None
                        for sec in parsed.sections.values():
                            for t in sec.tasks:
                                if t.uuid == match_uuid:
                                    existing = t
                                    break
                            if existing:
                                break

                        if existing is not None:
                            updated = add_session_ref_to_block(existing.raw, session_ref)
                            board_content = replace_task_block(board_content, existing.uuid, updated)
                            board_changed = True
                            linked_updates += 1
                        else:
                            # If the task can't be found, fall through to Unassigned creation.
                            should_link = False

                    if not should_link:
                        # Strategy (per Nita): create an Unassigned task for unmatched sessions.
                        title = _compact_title(str(payload.get("summary") or ""), fallback=session_ref, max_len=60)
                        snippets = payload.get("snippets") or []

                        body_lines: List[str] = [f"Session: {session_ref}", ""]
                        if isinstance(payload.get("summary"), str) and payload.get("summary"):
                            body_lines.append("Summary:")
                            body_lines.append(str(payload.get("summary")).strip())
                            body_lines.append("")
                        if isinstance(snippets, list) and snippets:
                            body_lines.append("Snippets:")
                            for sn in snippets[:6]:
                                if not isinstance(sn, dict):
                                    continue
                                role = sn.get("role")
                                text = sn.get("text")
                                if isinstance(text, str) and text.strip():
                                    one = text.strip().replace("\n", " ")
                                    body_lines.append(f"- {role}: {one[:200]}")

                        block = build_task_block(
                            title=title,
                            status="Unassigned",
                            tags=["session", "codex"],
                            body="\n".join(body_lines).strip(),
                            sessions=[session_ref],
                        )
                        parsed = parse_board(board_content)
                        first_unassigned = None
                        unassigned = parsed.sections.get("Unassigned")
                        if unassigned and unassigned.tasks:
                            first_unassigned = unassigned.tasks[0].uuid
                        board_content = insert_task_block(board_content, "Unassigned", first_unassigned, block)
                        board_changed = True
                        created_unassigned += 1
        except Exception as exc:
            errors += 1
            logger.exception(
                "sync_codex_sessions failed",
                exc_info=exc,
                extra={
                    "rollout": str(rollout),
                    "session_id": session_id or "unknown",
                },
            )
            continue

    if link_board and board_changed and board_content is not None:
        try:
            write_board_with_history(vault_dir, board_rel_path, board_content)
        except Exception:
            errors += 1

    state.sources.setdefault("codex", {})
    state.sources["codex"]["last_sync_at"] = _utc_now_iso()
    state.sources["codex"]["sessions_root"] = str(root)
    state.sources["codex"]["output_dir"] = str(out_dir)
    state.sources["codex"]["board_rel_path"] = board_rel_path
    state.sources["codex"]["match_mode"] = mode
    state.sources["codex"]["match_threshold"] = match_threshold
    state.sources["codex"]["ai_confidence_threshold"] = ai_confidence_threshold
    # `ai_top_k` is kept for backward compatibility, but now controls the per-call chunk size for AI matching.
    state.sources["codex"]["ai_top_k"] = ai_top_k
    state.sources["codex"]["ai_chunk_size"] = ai_top_k
    state.sources["codex"]["ai_provider"] = _normalize_ai_provider(ai_model.provider)
    if ai_model.model:
        state.sources["codex"]["ai_model"] = ai_model.model
    state.sources["codex"]["last_result"] = {
        "written": written,
        "skipped_old": skipped_old,
        "skipped_recent": skipped_recent,
        "skipped_existing": skipped_existing,
        "skipped_already_linked": skipped_already_linked,
        "linked_updates": linked_updates,
        "created_unassigned": created_unassigned,
        "errors": errors,
    }
    save_sessions_state(vault_dir, state)

    return dict(state.sources["codex"]["last_result"])
