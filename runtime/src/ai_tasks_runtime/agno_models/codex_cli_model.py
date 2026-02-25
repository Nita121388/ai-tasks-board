from __future__ import annotations

import asyncio
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
        result = run_codex_exec(
            prompt,
            codex_bin=self.codex_bin,
            args=self.codex_args,
            cwd=self.codex_cwd,
            timeout_s=self.timeout_s,
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
