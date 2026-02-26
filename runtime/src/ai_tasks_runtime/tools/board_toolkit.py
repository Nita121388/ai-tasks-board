from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from agno.tools.decorator import tool
from agno.tools.function import ToolResult
from agno.tools.toolkit import Toolkit

from ai_tasks_runtime.board_md import (
    add_session_ref_to_block,
    board_path_in_vault,
    build_task_block,
    ensure_board_file,
    insert_task_block,
    mark_task_archived,
    move_task_block,
    normalize_status,
    parse_board,
    remove_task_block,
    replace_task_block,
    rewrite_status_field,
    write_board_with_history,
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _utc_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _archive_rel_path(archive_folder: str, date_str: str) -> str:
    folder = (archive_folder or "Archive").replace("\\", "/").strip("/")
    return f"{folder}/{date_str}.md" if folder else f"{date_str}.md"


def _archive_template(date_str: str) -> str:
    return "\n".join(
        [
            "---",
            "schema: ai-tasks-archive/v1",
            f"date: {date_str}",
            "---",
            "",
            f"# Archive {date_str}",
            "",
            "",
        ]
    )


def _rewrite_title(block: str, title: str) -> str:
    t = (title or "").strip() or "(Untitled)"
    lines = block.replace("\r\n", "\n").split("\n")
    out: List[str] = []
    changed = False
    for line in lines:
        m = re.match(r"^(>\s*\[![^\]]+\])\s*(.*)\s*$", line)
        if m:
            out.append(f"{m.group(1)} {t}")
            changed = True
        else:
            out.append(line)
    return "\n".join(out) if changed else block


def _rewrite_tags(block: str, tags: Optional[List[str]]) -> str:
    if tags is None:
        return block
    tag_list = [t.strip() for t in (tags or []) if isinstance(t, str) and t.strip()]

    lines = block.replace("\r\n", "\n").split("\n")
    out: List[str] = []
    tags_idx = -1
    for i, line in enumerate(lines):
        if re.match(r"^>\s*tags::", line, flags=re.IGNORECASE):
            tags_idx = i
            break

    if not tag_list:
        if tags_idx == -1:
            return block
        # Remove existing tags line.
        lines.pop(tags_idx)
        return "\n".join(lines)

    new_line = "> tags:: " + ", ".join(tag_list)
    if tags_idx != -1:
        lines[tags_idx] = new_line
        return "\n".join(lines)

    # Insert tags after status if possible, else after callout.
    insert_after = -1
    for i, line in enumerate(lines):
        if re.match(r"^>\s*status::", line, flags=re.IGNORECASE):
            insert_after = i
            break
    if insert_after == -1:
        for i, line in enumerate(lines):
            if re.match(r"^>\s*\[![^\]]+\]", line):
                insert_after = i
                break
    if insert_after == -1:
        insert_after = 0
    lines.insert(insert_after + 1, new_line)
    return "\n".join(lines)


def _rewrite_body(block: str, body: Optional[str]) -> str:
    if body is None:
        return block

    text = block.replace("\r\n", "\n")
    lines = text.split("\n")

    # Locate END marker line (keep it and anything after it).
    end_idx = -1
    for i, line in enumerate(lines):
        if re.match(r"^<!--\s*AI-TASKS:TASK\s+[0-9a-fA-F-]{8,}\s+END\s*-->$", line.strip()):
            end_idx = i
            break
    if end_idx == -1:
        return block

    # Locate the first ">" delimiter that starts the body.
    body_delim_idx = -1
    for i, line in enumerate(lines):
        if line.strip() == ">":
            body_delim_idx = i
            break
    if body_delim_idx == -1 or body_delim_idx >= end_idx:
        return block

    head = lines[: body_delim_idx + 1]
    tail = lines[end_idx:]

    body_lines = (body or "").replace("\r\n", "\n").split("\n")
    body_out: List[str] = []
    for bl in body_lines:
        if bl.strip() == "":
            body_out.append(">")
        else:
            body_out.append("> " + bl)

    merged = head + body_out + tail
    return "\n".join(merged)


@dataclass
class BoardToolkit(Toolkit):
    """Tools for reading/writing the Obsidian `Board.md` file."""

    vault_dir: Path
    board_rel_path: str = "Tasks/Boards/Board.md"

    def __post_init__(self):
        super().__init__(
            name="board",
            tools=[
                self.board_list_tasks,
                self.board_get_task,
                self.board_create_task,
                self.board_update_task,
                self.board_move_task,
                self.board_append_session,
                self.board_archive_task,
            ],
        )

    def _board_path(self) -> Path:
        return board_path_in_vault(self.vault_dir, self.board_rel_path)

    def _read_board(self) -> str:
        path = ensure_board_file(self.vault_dir, self.board_rel_path)
        return path.read_text(encoding="utf-8")

    def _write_board(self, next_content: str) -> None:
        write_board_with_history(self.vault_dir, self.board_rel_path, next_content)

    @tool(description="List task summaries from Board.md. Optional status filter.")
    def board_list_tasks(self, status: Optional[str] = None, limit: int = 200) -> ToolResult:
        content = self._read_board()
        parsed = parse_board(content)
        want = normalize_status(status) if status else None

        tasks = []
        for sec in parsed.sections.values():
            for t in sec.tasks:
                if want and t.status != want:
                    continue
                tasks.append(
                    {
                        "uuid": t.uuid,
                        "title": t.title,
                        "status": t.status,
                        "tags": t.tags,
                    }
                )
        tasks = tasks[: max(1, int(limit or 200))]
        return ToolResult(content=json.dumps({"count": len(tasks), "tasks": tasks}, ensure_ascii=False))

    @tool(description="Get the raw Markdown block for a task UUID.")
    def board_get_task(self, uuid: str) -> ToolResult:
        content = self._read_board()
        parsed = parse_board(content)
        tuid = (uuid or "").lower()
        for sec in parsed.sections.values():
            for t in sec.tasks:
                if t.uuid == tuid:
                    return ToolResult(content=t.raw)
        return ToolResult(content=f"Error: task not found: {uuid}")

    @tool(description="Create a new task block and insert it into the board.")
    def board_create_task(
        self,
        title: str,
        status: str = "Unassigned",
        tags: Optional[List[str]] = None,
        body: str = "",
        before_uuid: Optional[str] = None,
    ) -> ToolResult:
        st = normalize_status(status) or "Unassigned"
        tuid = str(uuid.uuid4()).lower()
        block = build_task_block(task_uuid=tuid, title=title, status=st, tags=tags or [], body=body)

        content = self._read_board()
        next_content = insert_task_block(content, st, before_uuid.lower() if before_uuid else None, block)
        self._write_board(next_content)
        return ToolResult(
            content=json.dumps({"ok": True, "action": "create", "uuid": tuid, "status": st}, ensure_ascii=False)
        )

    @tool(description="Update an existing task. Can also move it if status/before_uuid is provided.")
    def board_update_task(
        self,
        uuid: str,
        title: Optional[str] = None,
        status: Optional[str] = None,
        tags: Optional[List[str]] = None,
        body: Optional[str] = None,
        before_uuid: Optional[str] = None,
    ) -> ToolResult:
        content = self._read_board()
        parsed = parse_board(content)

        tuid = (uuid or "").lower()
        existing = None
        from_status = None
        for sec in parsed.sections.values():
            for t in sec.tasks:
                if t.uuid == tuid:
                    existing = t
                    from_status = sec.status
                    break
            if existing:
                break
        if existing is None or from_status is None:
            return ToolResult(content=f"Error: task not found: {uuid}")

        target_status = normalize_status(status) if status else from_status
        target_status = target_status or from_status

        block = existing.raw
        if title is not None:
            block = _rewrite_title(block, title)
        if tags is not None:
            block = _rewrite_tags(block, tags)
        if body is not None:
            block = _rewrite_body(block, body)

        # Ensure status field matches target.
        if target_status != from_status:
            block = rewrite_status_field(block, target_status)
        elif status is not None:
            block = rewrite_status_field(block, target_status)

        # Move (remove+insert) when changing section OR explicit reordering requested.
        needs_move = (target_status != from_status) or (before_uuid is not None and before_uuid.strip() != "")
        if needs_move:
            removed, after_removal = remove_task_block(content, tuid)
            effective_before = None if (before_uuid or "").lower() == tuid else (before_uuid.lower() if before_uuid else None)
            next_content = insert_task_block(after_removal, target_status, effective_before, block)
        else:
            next_content = replace_task_block(content, tuid, block)

        self._write_board(next_content)
        return ToolResult(
            content=json.dumps(
                {"ok": True, "action": "update", "uuid": tuid, "from_status": from_status, "status": target_status},
                ensure_ascii=False,
            )
        )

    @tool(description="Move/reorder a task within the board.")
    def board_move_task(self, uuid: str, to_status: str, before_uuid: Optional[str] = None) -> ToolResult:
        st = normalize_status(to_status) or "Unassigned"
        content = self._read_board()
        next_content = move_task_block(content, uuid, st, before_uuid)
        self._write_board(next_content)
        return ToolResult(content=json.dumps({"ok": True, "action": "move", "uuid": uuid, "status": st}, ensure_ascii=False))

    @tool(description="Append a session ref (e.g. codex:<id>) into a task block.")
    def board_append_session(self, uuid: str, session_ref: str) -> ToolResult:
        content = self._read_board()
        parsed = parse_board(content)
        tuid = (uuid or "").lower()
        existing = None
        for sec in parsed.sections.values():
            for t in sec.tasks:
                if t.uuid == tuid:
                    existing = t
                    break
            if existing:
                break
        if existing is None:
            return ToolResult(content=f"Error: task not found: {uuid}")

        updated = add_session_ref_to_block(existing.raw, session_ref)
        next_content = replace_task_block(content, tuid, updated)
        self._write_board(next_content)
        return ToolResult(content=json.dumps({"ok": True, "action": "append_session", "uuid": tuid}, ensure_ascii=False))

    @tool(description="Archive a task (remove from board and append to Archive/YYYY-MM-DD.md).")
    def board_archive_task(
        self,
        uuid: str,
        archive_folder: str = "Archive",
        date_str: Optional[str] = None,
    ) -> ToolResult:
        date_str = (date_str or "").strip() or _utc_today()

        board_content = self._read_board()
        removed, next_board = remove_task_block(board_content, uuid)
        archived_block = mark_task_archived(removed.raw, _utc_now_iso())
        self._write_board(next_board)

        rel = _archive_rel_path(archive_folder, date_str)
        path = self.vault_dir / Path(*rel.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            existing = path.read_text(encoding="utf-8")
            if not existing.endswith("\n"):
                existing += "\n"
            path.write_text(existing + archived_block, encoding="utf-8")
        else:
            path.write_text(_archive_template(date_str) + archived_block, encoding="utf-8")

        return ToolResult(
            content=json.dumps({"ok": True, "action": "archive", "uuid": uuid, "archive_path": rel}, ensure_ascii=False)
        )

