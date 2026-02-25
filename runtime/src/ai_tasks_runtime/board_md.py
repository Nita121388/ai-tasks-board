from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple


AUTO_BEGIN = "<!-- AI-TASKS:BEGIN -->"
AUTO_END = "<!-- AI-TASKS:END -->"

STATUSES = ["Unassigned", "Todo", "Doing", "Review", "Done"]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_status(s: str) -> Optional[str]:
    t = (s or "").strip()
    return t if t in STATUSES else None


def build_default_board_markdown() -> str:
    lines = [
        "---",
        "schema: ai-tasks-board/v1",
        "board_id: ai-tasks-board",
        "statuses: [Unassigned, Todo, Doing, Review, Done]",
        "---",
        "",
        "# AI Tasks Board",
        "",
        AUTO_BEGIN,
        "## Unassigned",
        "",
        "## Todo",
        "",
        "## Doing",
        "",
        "## Review",
        "",
        "## Done",
        AUTO_END,
        "",
    ]
    return "\n".join(lines)


def board_path_in_vault(vault_dir: Path, board_rel_path: str) -> Path:
    rel = (board_rel_path or "Tasks/Boards/Board.md").replace("\\", "/").strip("/")
    return vault_dir / Path(*rel.split("/"))


def ensure_board_file(vault_dir: Path, board_rel_path: str) -> Path:
    path = board_path_in_vault(vault_dir, board_rel_path)
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(build_default_board_markdown(), encoding="utf-8")
    return path


def history_path_for_board(board_rel_path: str, ts: str) -> str:
    # Mirror the plugin behavior: if the board lives in */Boards/*, snapshot under */History/Boards/*.
    norm = (board_rel_path or "Tasks/Boards/Board.md").replace("\\", "/")
    base_name = norm.split("/")[-1] or "Board.md"
    stamped = re.sub(r"\.md$", f".{ts}.md", base_name, flags=re.IGNORECASE)

    idx = norm.rfind("/Boards/")
    if idx != -1:
        prefix = norm[:idx]
        return f"{prefix}/History/Boards/{stamped}" if prefix else f"History/Boards/{stamped}"

    parent = "/".join(norm.split("/")[:-1])
    return f"{parent}/History/{stamped}" if parent else f"History/{stamped}"


def write_board_with_history(vault_dir: Path, board_rel_path: str, next_content: str) -> None:
    board_path = board_path_in_vault(vault_dir, board_rel_path)
    current = board_path.read_text(encoding="utf-8") if board_path.exists() else build_default_board_markdown()

    # Snapshot current board before writing.
    ts = _utc_now_iso().replace(":", "-").replace(".", "-")
    hist_rel = history_path_for_board(board_rel_path, ts)
    hist_path = vault_dir / Path(*hist_rel.split("/"))
    hist_path.parent.mkdir(parents=True, exist_ok=True)
    hist_path.write_text(current, encoding="utf-8")

    board_path.parent.mkdir(parents=True, exist_ok=True)
    board_path.write_text(next_content, encoding="utf-8")


@dataclass
class TaskBlock:
    uuid: str
    title: str
    status: str
    tags: List[str]
    raw: str
    start: int
    end: int


@dataclass
class Section:
    status: str
    heading_start: int
    heading_end: int
    section_start: int
    section_end: int
    tasks: List[TaskBlock]


@dataclass
class ParsedBoard:
    content: str
    auto_start: int
    auto_end: int
    sections: Dict[str, Section]


_TASK_BEGIN_RE = re.compile(r"<!--\s*AI-TASKS:TASK\s+([0-9a-fA-F-]{8,})\s+BEGIN\s*-->")


def _parse_title(block: str) -> str:
    for line in block.splitlines():
        m = re.match(r"^>\s*\[![^\]]+\]\s*(.+)\s*$", line)
        if m and m.group(1):
            return m.group(1).strip()
    return "(Untitled)"


def _parse_tags(block: str) -> List[str]:
    for line in block.splitlines():
        m = re.match(r"^>\s*tags::\s*(.+)\s*$", line, flags=re.IGNORECASE)
        if not m or not m.group(1):
            continue
        raw = m.group(1)
        parts = re.split(r"[,，]", raw)
        out = []
        for p in parts:
            t = p.strip()
            if t:
                out.append(t)
        return out
    return []


def _parse_status_field(block: str) -> Optional[str]:
    for line in block.splitlines():
        m = re.match(r"^>\s*status::\s*(.+)\s*$", line, flags=re.IGNORECASE)
        if m and m.group(1):
            return normalize_status(m.group(1)) or None
    return None


def find_auto_area(content: str) -> Tuple[int, int]:
    begin_idx = content.find(AUTO_BEGIN)
    end_idx = content.find(AUTO_END)
    if begin_idx == -1 or end_idx == -1 or end_idx <= begin_idx:
        raise ValueError(f"Board is missing auto area markers ({AUTO_BEGIN} / {AUTO_END}).")
    auto_start = begin_idx + len(AUTO_BEGIN)
    auto_end = end_idx
    return auto_start, auto_end


def parse_board(content: str) -> ParsedBoard:
    auto_start, auto_end = find_auto_area(content)
    auto = content[auto_start:auto_end]
    lines = auto.split("\n")

    # Track absolute offsets.
    offset = auto_start
    headings: List[Tuple[str, int, int]] = []
    for line in lines:
        trimmed = line.lstrip()
        if trimmed.startswith("## "):
            status = normalize_status(trimmed[3:].strip() or "")
            if status:
                start = offset + line.find("## ")
                end = offset + len(line)
                headings.append((status, start, end))
        offset += len(line) + 1

    sections: Dict[str, Section] = {}
    for i, h in enumerate(headings):
        status, h_start, h_end = h
        next_h = headings[i + 1] if i + 1 < len(headings) else None
        section_start = h_end + 1
        section_end = next_h[1] if next_h else auto_end

        section_text = content[section_start:section_end]
        tasks: List[TaskBlock] = []

        for m in _TASK_BEGIN_RE.finditer(section_text):
            tuid = m.group(1)
            if not tuid:
                continue
            begin_rel = m.start()
            begin_abs = section_start + begin_rel
            end_marker = f"<!-- AI-TASKS:TASK {tuid} END -->"
            end_rel = section_text.find(end_marker, begin_rel)
            if end_rel == -1:
                continue
            end_abs = section_start + end_rel + len(end_marker)

            end_abs_expanded = end_abs
            # Consume trailing newline(s) for cleaner replacement.
            while end_abs_expanded < len(content) and content[end_abs_expanded] == "\n":
                end_abs_expanded += 1
                if end_abs_expanded < len(content) and content[end_abs_expanded] == "\n":
                    end_abs_expanded += 1
                break

            raw_block = content[begin_abs:end_abs_expanded]
            parsed_status = _parse_status_field(raw_block) or status
            tasks.append(
                TaskBlock(
                    uuid=tuid.lower(),
                    title=_parse_title(raw_block),
                    status=parsed_status,
                    tags=_parse_tags(raw_block),
                    raw=raw_block,
                    start=begin_abs,
                    end=end_abs_expanded,
                )
            )

        sections[status] = Section(
            status=status,
            heading_start=h_start,
            heading_end=h_end,
            section_start=section_start,
            section_end=section_end,
            tasks=tasks,
        )

    return ParsedBoard(content=content, auto_start=auto_start, auto_end=auto_end, sections=sections)


def build_task_block(
    *,
    task_uuid: Optional[str] = None,
    title: str,
    status: str = "Unassigned",
    tags: Optional[List[str]] = None,
    body: str = "",
    sessions: Optional[List[str]] = None,
) -> str:
    tuid = (task_uuid or str(uuid.uuid4())).lower()
    st = normalize_status(status) or "Unassigned"
    tag_list = tags or []
    created = _utc_now_iso()

    lines: List[str] = []
    lines.append(f"<!-- AI-TASKS:TASK {tuid} BEGIN -->")
    lines.append(f"> [!todo] {title.strip() or '(Untitled)'}")
    lines.append(f"> status:: {st}")
    if tag_list:
        lines.append("> tags:: " + ", ".join(tag_list))
    if sessions:
        lines.append("> sessions:: " + ", ".join(sessions))
    lines.append(f"> created:: {created}")
    lines.append(">")

    body_lines = (body or "").replace("\r\n", "\n").split("\n")
    for bl in body_lines:
        if bl.strip() == "":
            lines.append(">")
        else:
            lines.append("> " + bl)

    lines.append(f"<!-- AI-TASKS:TASK {tuid} END -->")
    return "\n".join(lines) + "\n"


def _find_insertion_point(parsed: ParsedBoard, to_status: str, before_uuid: Optional[str]) -> int:
    status = normalize_status(to_status) or "Unassigned"
    section = parsed.sections.get(status)
    if not section:
        raise ValueError(f"Missing status section: {status}")

    if before_uuid:
        for t in section.tasks:
            if t.uuid == before_uuid.lower():
                return t.start

    last = section.tasks[-1] if section.tasks else None
    if last:
        return last.end
    return section.section_start


def insert_task_block(content: str, to_status: str, before_uuid: Optional[str], block: str) -> str:
    parsed = parse_board(content)
    insert_at = _find_insertion_point(parsed, to_status, before_uuid)

    prefix = content[:insert_at]
    suffix = content[insert_at:]
    needs_leading_nl = bool(prefix) and not prefix.endswith("\n")
    needs_trailing_nl = not block.endswith("\n")
    final_block = ("\n" if needs_leading_nl else "") + block + ("\n" if needs_trailing_nl else "")
    return prefix + final_block + suffix


def replace_task_block(content: str, task_uuid: str, block: str) -> str:
    parsed = parse_board(content)
    tuid = task_uuid.lower()
    existing: Optional[TaskBlock] = None
    for section in parsed.sections.values():
        for t in section.tasks:
            if t.uuid == tuid:
                existing = t
                break
        if existing:
            break
    if not existing:
        raise ValueError(f"Task not found: {task_uuid}")

    final_block = block if block.endswith("\n") else block + "\n"
    return content[: existing.start] + final_block + content[existing.end :]


def add_session_ref_to_block(block: str, session_ref: str) -> str:
    ref = (session_ref or "").strip()
    if not ref:
        return block

    lines = block.replace("\r\n", "\n").replace("\n", "\n").split("\n")

    sessions_idx = -1
    for i, line in enumerate(lines):
        if re.match(r"^>\s*sessions::", line, flags=re.IGNORECASE):
            sessions_idx = i
            break

    if sessions_idx != -1:
        m = re.match(r"^(>\s*sessions::\s*)(.*)$", lines[sessions_idx], flags=re.IGNORECASE)
        prefix = m.group(1) if m else "> sessions:: "
        raw = m.group(2) if m else ""
        existing = [p.strip() for p in re.split(r"[,，]", raw) if p.strip()]
        if any(p.lower() == ref.lower() for p in existing):
            return block if block.endswith("\n") else block + "\n"
        existing.append(ref)
        lines[sessions_idx] = prefix + ", ".join(existing)
        return "\n".join(lines).rstrip("\n") + "\n"

    # Insert sessions field after tags/status/header if missing.
    insert_after = -1
    for i, line in enumerate(lines):
        if re.match(r"^>\s*tags::", line, flags=re.IGNORECASE):
            insert_after = i
            break
    if insert_after == -1:
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

    lines.insert(insert_after + 1, f"> sessions:: {ref}")
    return "\n".join(lines).rstrip("\n") + "\n"

