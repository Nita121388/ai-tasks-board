from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Iterator, List, Optional, Type, Union

from pydantic import BaseModel

from agno.models.base import Model
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.run.agent import RunOutput
from agno.run.team import TeamRunOutput

from ai_tasks_runtime.codex_cli import run_codex_exec


def _messages_to_prompt(messages: List[Message]) -> str:
    """Flatten Agno messages into a single prompt string for Codex CLI.

    Preserve the direct `codex exec` behavior as much as possible:
    - If this run is a single user message (common in this project), pass it through as-is.
    - Otherwise, join messages with simple ROLE headings.
    """

    if len(messages) == 1:
        m = messages[0]
        if (m.role or "").strip().lower() == "user":
            return m.get_content_string()

    parts: List[str] = []
    for m in messages:
        role = (m.role or "").strip().upper()
        content = m.get_content_string()
        parts.append(f"{role}:\n{content}\n")
    parts.append("ASSISTANT:\n")
    return "\n".join(parts)


def _strip_code_fences(text: str) -> str:
    t = (text or "").strip()
    if not t.startswith("```"):
        return t
    # Extract the first fenced block content.
    lines = t.replace("\r\n", "\n").split("\n")
    if not lines:
        return t
    if not lines[0].strip().startswith("```"):
        return t
    out: List[str] = []
    for line in lines[1:]:
        if line.strip().startswith("```"):
            break
        out.append(line)
    return "\n".join(out).strip()


def _parse_first_json_obj(text: str) -> Optional[Any]:
    """Best-effort JSON extraction from model text."""
    t = _strip_code_fences(text)
    if not t:
        return None

    # Fast-path: raw JSON.
    if t.startswith("{") or t.startswith("["):
        try:
            return json.loads(t)
        except Exception:
            pass

    # Best-effort: take the first {...} span.
    start = t.find("{")
    end = t.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    snippet = t[start : end + 1]
    try:
        return json.loads(snippet)
    except Exception:
        return None


def _normalize_tool_calls(obj: Any) -> Optional[List[Dict[str, Any]]]:
    """Convert a model-emitted tool-call blob into OpenAI-style tool_calls dicts.

    We accept a few "LLM-friendly" shapes and convert them into:
    {"id": "...", "type": "function", "function": {"name": "...", "arguments": "{...json...}"}}
    """

    if obj is None:
        return None

    tool_calls_raw: Any = None
    if isinstance(obj, dict):
        if isinstance(obj.get("tool_calls"), list):
            tool_calls_raw = obj.get("tool_calls")
        # Allow a single-call shortcut: {"name": "...", "args": {...}}
        elif isinstance(obj.get("name"), str) and isinstance(obj.get("args"), dict):
            tool_calls_raw = [obj]
        elif isinstance(obj.get("tool_name"), str) and isinstance(obj.get("arguments"), (dict, str)):
            tool_calls_raw = [obj]
    elif isinstance(obj, list):
        tool_calls_raw = obj

    if tool_calls_raw is None:
        return None

    normalized: List[Dict[str, Any]] = []
    for item in tool_calls_raw:
        if not isinstance(item, dict):
            continue

        call_id = item.get("id")
        if not isinstance(call_id, str) or not call_id.strip():
            call_id = f"call_{uuid.uuid4().hex}"

        # Case A: Already OpenAI-style-ish.
        if item.get("type") == "function" and isinstance(item.get("function"), dict):
            fn = item.get("function") or {}
            name = fn.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            args_val = fn.get("arguments")
            if isinstance(args_val, dict):
                args_str = json.dumps(args_val, ensure_ascii=False)
            elif isinstance(args_val, str):
                args_str = args_val
            else:
                args_str = "{}"

            normalized.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": args_str},
                }
            )
            continue

        # Case B: LLM-friendly: {"name": "...", "args": {...}}.
        name = item.get("name") or item.get("tool_name")
        if not isinstance(name, str) or not name.strip():
            continue
        args_val = item.get("args") if "args" in item else item.get("arguments")
        if isinstance(args_val, dict):
            args_str = json.dumps(args_val, ensure_ascii=False)
        elif isinstance(args_val, str):
            args_str = args_val
        else:
            args_str = "{}"

        normalized.append(
            {
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": args_str},
            }
        )

    return normalized or None


def _tools_prelude(tools: List[Dict[str, Any]], tool_choice: Optional[Union[str, Dict[str, Any]]]) -> str:
    # Keep prompt concise: list tool schemas as JSON, then define the output protocol.
    tools_json = json.dumps(tools, ensure_ascii=False)
    forced = ""
    if isinstance(tool_choice, dict):
        fn = (tool_choice.get("function") or {}) if tool_choice.get("type") == "function" else {}
        name = fn.get("name") if isinstance(fn, dict) else None
        if isinstance(name, str) and name.strip():
            forced = f"\nTool choice is forced: you MUST call `{name}`.\n"

    return (
        "You can call tools.\n"
        "You do NOT have direct shell/filesystem access here. Do NOT try to run commands.\n"
        "If you need to inspect or modify state, call a tool by emitting JSON.\n"
        "When you call a tool, respond with ONLY valid JSON (no markdown, no code fences).\n"
        "Preferred format:\n"
        '{\"tool_calls\": [{\"name\": \"tool_name\", \"args\": {\"key\": \"value\"}}]}\n'
        "Rules:\n"
        "- tool_name MUST match one of the available tools.\n"
        "- args MUST be a JSON object.\n"
        "- If multiple tool calls are needed, return multiple entries.\n"
        "- If no tool is needed, respond with plain text (NOT JSON).\n"
        f"{forced}"
        f"Available tools (JSON schema):\n{tools_json}\n\n"
    )


@dataclass
class CodexCLIModel(Model):
    """Agno Model provider backed by local Codex CLI (`codex exec --json`).

    This is intentionally conservative:
    - default sandbox: read-only
    - default approval policy: untrusted

    Streaming is emulated (single final chunk), because Codex CLI JSONL does not expose token deltas.
    """

    codex_bin: str = "codex"
    codex_args: Optional[List[str]] = None
    codex_cwd: Optional[Path] = None
    timeout_s: int = 120

    def invoke(
        self,
        messages: List[Message],
        assistant_message: Message,
        response_format: Optional[Union[Dict, Type[BaseModel]]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        run_response: Optional[Union[RunOutput, TeamRunOutput]] = None,
        compress_tool_results: bool = False,
    ) -> ModelResponse:
        prompt = _messages_to_prompt(messages)
        if tools and str(tool_choice).lower() != "none":
            prompt = _tools_prelude(tools, tool_choice) + prompt
        result = run_codex_exec(
            prompt,
            codex_bin=self.codex_bin,
            args=self.codex_args,
            cwd=self.codex_cwd,
            timeout_s=self.timeout_s,
        )

        tool_calls = _normalize_tool_calls(_parse_first_json_obj(result.text))
        if tool_calls:
            return ModelResponse(
                role="assistant",
                content=None,
                tool_calls=tool_calls,
                provider_data={
                    "provider": "codex-cli",
                    "thread_id": result.thread_id,
                    "usage": result.usage,
                },
            )
        return ModelResponse(
            role="assistant",
            content=result.text,
            provider_data={
                "provider": "codex-cli",
                "thread_id": result.thread_id,
                "usage": result.usage,
            },
        )

    async def ainvoke(
        self,
        messages: List[Message],
        assistant_message: Message,
        response_format: Optional[Union[Dict, Type[BaseModel]]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        run_response: Optional[Union[RunOutput, TeamRunOutput]] = None,
        compress_tool_results: bool = False,
    ) -> ModelResponse:
        return await asyncio.to_thread(
            self.invoke,
            messages,
            assistant_message,
            response_format,
            tools,
            tool_choice,
            run_response,
            compress_tool_results,
        )

    def invoke_stream(
        self,
        messages: List[Message],
        assistant_message: Message,
        response_format: Optional[Union[Dict, Type[BaseModel]]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        run_response: Optional[Union[RunOutput, TeamRunOutput]] = None,
        compress_tool_results: bool = False,
    ) -> Iterator[ModelResponse]:
        yield self.invoke(messages, assistant_message, response_format, tools, tool_choice, run_response, compress_tool_results)

    async def ainvoke_stream(
        self,
        messages: List[Message],
        assistant_message: Message,
        response_format: Optional[Union[Dict, Type[BaseModel]]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        run_response: Optional[Union[RunOutput, TeamRunOutput]] = None,
        compress_tool_results: bool = False,
    ) -> AsyncIterator[ModelResponse]:
        yield await self.ainvoke(messages, assistant_message, response_format, tools, tool_choice, run_response, compress_tool_results)

    def _parse_provider_response(self, response: Any, **kwargs) -> ModelResponse:
        # Not used: invoke() already returns a ModelResponse.
        if isinstance(response, ModelResponse):
            return response
        return ModelResponse(role="assistant", content=str(response))

    def _parse_provider_response_delta(self, response: Any) -> ModelResponse:
        # No true deltas available from Codex CLI; treat each delta as a final chunk.
        if isinstance(response, ModelResponse):
            return response
        return ModelResponse(role="assistant", content=str(response))
