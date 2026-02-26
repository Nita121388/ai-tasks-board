from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional


PROMPTS_DIRNAME = "prompts"


@dataclass(frozen=True)
class PromptSpec:
    key: str
    filename: str
    description: str
    template: str


def _safe_filename(name: str) -> str:
    # Keep prompt filenames cross-platform and human-readable.
    out = re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "").strip())
    out = re.sub(r"_+", "_", out).strip("_.-")
    return out or "prompt"


PROMPTS: Dict[str, PromptSpec] = {
    "board.propose.v1": PromptSpec(
        key="board.propose.v1",
        filename="board.propose.v1.md",
        description="Decide create vs update for a board task from a user draft.",
        template=(
            "{{ctx}}"
            "You are helping maintain an Obsidian Markdown task board.\n"
            "Given a user draft text, decide whether to create a new task or update an existing one.\n"
            "\n"
            "Return ONLY valid JSON with this shape:\n"
            "{\n"
            '  \"action\": \"create\"|\"update\",\n'
            '  \"target_uuid\": string|null,\n'
            '  \"title\": string,\n'
            '  \"status\": \"Unassigned\"|\"Todo\"|\"Doing\"|\"Review\"|\"Done\",\n'
            '  \"tags\": string[],\n'
            '  \"body\": string,\n'
            '  \"reasoning\": string,\n'
            '  \"confidence\": number\n'
            "}\n"
            "\n"
            "Mode hint: {{mode}}\n"
            "Existing tasks (JSON):\n"
            "{{tasks_json}}\n"
            "\n"
            "Tag presets (JSON, optional; prefer these when possible):\n"
            "{{tag_presets_json}}\n"
            "\n"
            "User draft:\n"
            "{{draft}}\n"
            "\n"
            "{{instruction_block}}"
        ),
    ),
    "board.split.v1": PromptSpec(
        key="board.split.v1",
        filename="board.split.v1.md",
        description="Split a user text blob into multiple tasks with titles + tags.",
        template=(
            "{{ctx}}"
            "You are helping maintain an Obsidian Markdown task board.\n"
            "Given an unstructured or semi-structured text blob, split it into multiple tasks.\n"
            "\n"
            "Return ONLY valid JSON with this shape:\n"
            "{\n"
            '  \"tasks\": [\n'
            "    {\n"
            '      \"title\": string,\n'
            '      \"status\": \"Unassigned\"|\"Todo\"|\"Doing\"|\"Review\"|\"Done\",\n'
            '      \"tags\": string[],\n'
            '      \"body\": string\n'
            "    }\n"
            "  ],\n"
            '  \"reasoning\": string,\n'
            '  \"confidence\": number\n'
            "}\n"
            "\n"
            "Rules:\n"
            "- Extract each actionable item as a separate task.\n"
            "- Task title should be short and specific (<= 16 Chinese chars or <= 80 Latin chars).\n"
            "- Prefer tags from tag_presets when provided; choose 1-3 tags per task.\n"
            "- Limit tasks to max_tasks={{max_tasks}}.\n"
            "\n"
            "Tag presets (JSON):\n"
            "{{tag_presets_json}}\n"
            "\n"
            "Input text:\n"
            "{{text}}\n"
            "\n"
            "{{instruction_block}}"
        ),
    ),
    "board.agent.apply.v1": PromptSpec(
        key="board.agent.apply.v1",
        filename="board.agent.apply.v1.md",
        description="Use tools to create/update tasks in Board.md from a user draft (agentic tool-calling mode).",
        template=(
            "{{ctx}}"
            "You are maintaining an Obsidian Markdown task board.\n"
            "Use the available tools to inspect the board and then create/update/move/archive tasks.\n"
            "\n"
            "Rules:\n"
            "- Prefer minimal changes. Do not rewrite the whole board.\n"
            "- If unsure which task to update, create a new task instead of guessing.\n"
            "- After tool calls finish, reply with a short summary (what changed, which UUIDs).\n"
            "\n"
            "Mode hint: {{mode}}\n"
            "\n"
            "User draft:\n"
            "{{draft}}\n"
            "\n"
            "{{instruction_block}}"
        ),
    ),
    "sessions.codex.summarize.v1": PromptSpec(
        key="sessions.codex.summarize.v1",
        filename="sessions.codex.summarize.v1.md",
        description="Summarize a Codex CLI session (Mode B) from recent messages.",
        template=(
            "Summarize this Codex CLI session in Chinese within 2 sentences.\n"
            "Avoid leaking secrets; generalize paths/tokens if present.\n"
            "Return plain text only.\n"
            "\n"
            "{{convo}}\n"
        ),
    ),
    "sessions.codex.match_task.v1": PromptSpec(
        key="sessions.codex.match_task.v1",
        filename="sessions.codex.match_task.v1.md",
        description="Choose the best matching task UUID for a session among candidates.",
        template=(
            "{{ctx}}"
            "You are linking a Codex CLI session to an existing task in an Obsidian Markdown board.\n"
            "Choose the best matching task UUID from the candidate list, or choose null if none fit.\n"
            "\n"
            "Return ONLY valid JSON:\n"
            "{\n"
            '  \"target_uuid\": string|null,\n'
            '  \"confidence\": number,\n'
            '  \"reasoning\": string\n'
            "}\n"
            "\n"
            "Rules:\n"
            "- target_uuid MUST be one of the candidate uuids or null.\n"
            "- If uncertain, return null with low confidence.\n"
            "\n"
            "Session:\n"
            "{{session_text}}\n"
            "\n"
            "Candidate tasks (JSON):\n"
            "{{candidates_json}}\n"
        ),
    ),
    "agent.ask.v1": PromptSpec(
        key="agent.ask.v1",
        filename="agent.ask.v1.md",
        description="Agent ask wrapper that injects workspace context (SOUL/USER/MEMORY) then asks a task.",
        template=(
            "{{prelude}}\n"
            "# Task\n"
            "{{task}}\n"
            "\n"
            "Return plain text only.\n"
        ),
    ),
}


_VAR_RE = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")


def list_prompt_specs() -> Iterable[PromptSpec]:
    return PROMPTS.values()


def prompt_override_path(agent_dir: Path, prompt_key: str) -> Path:
    agent_dir = agent_dir.expanduser().resolve()
    spec = PROMPTS.get(prompt_key)
    filename = spec.filename if spec is not None else f"{_safe_filename(prompt_key)}.md"
    return agent_dir / PROMPTS_DIRNAME / filename


def load_prompt_template(agent_dir: Optional[Path], prompt_key: str) -> str:
    spec = PROMPTS.get(prompt_key)
    if spec is None:
        raise KeyError(f"unknown prompt_key: {prompt_key}")

    if agent_dir is not None:
        path = prompt_override_path(agent_dir, prompt_key)
        if path.exists():
            try:
                return path.read_text(encoding="utf-8")
            except Exception:
                # If an override exists but can't be read, fall back to default.
                pass
    return spec.template


def _render_template(template: str, vars: Dict[str, str]) -> str:
    keys = set(_VAR_RE.findall(template))
    missing = [k for k in sorted(keys) if k not in vars]
    if missing:
        raise ValueError(f"missing template vars: {missing}")

    def repl(m: re.Match[str]) -> str:
        k = m.group(1)
        return str(vars.get(k, ""))

    return _VAR_RE.sub(repl, template)


def render_prompt(agent_dir: Optional[Path], prompt_key: str, vars: Dict[str, str]) -> str:
    template = load_prompt_template(agent_dir, prompt_key)
    return _render_template(template, vars)


def ensure_prompt_files(agent_dir: Path, *, force: bool = False) -> Dict[str, str]:
    """Create prompt override files under `agent/prompts/` (missing-only by default)."""
    agent_dir = agent_dir.expanduser().resolve()
    prompts_dir = agent_dir / PROMPTS_DIRNAME
    prompts_dir.mkdir(parents=True, exist_ok=True)

    created: Dict[str, str] = {}

    readme = prompts_dir / "README.md"
    if force or not readme.exists():
        readme.write_text(
            "# Agent Prompts (Override)\n\n"
            "This folder contains prompt templates used by the AI Tasks runtime.\n\n"
            "Rules:\n"
            "- Each prompt has a stable `prompt_key` like `board.propose.v1`.\n"
            "- If a file exists here, the runtime uses it instead of the built-in default.\n"
            "- Keep outputs strict (JSON-only where required).\n"
            "- If you break JSON constraints, the runtime will fall back to heuristics.\n\n"
            "Files:\n"
            + "".join([f"- `{p.filename}` ({p.key})\n" for p in list_prompt_specs()])
            + "\n",
            encoding="utf-8",
        )
        created[f"{PROMPTS_DIRNAME}/README.md"] = "written" if force else "created"

    for spec in list_prompt_specs():
        path = prompts_dir / spec.filename
        if path.exists() and not force:
            created[f"{PROMPTS_DIRNAME}/{spec.filename}"] = "exists"
            continue
        path.write_text(spec.template.rstrip() + "\n", encoding="utf-8")
        created[f"{PROMPTS_DIRNAME}/{spec.filename}"] = "written" if force else "created"

    return created
