import { BoardSection, BoardStatus, BoardTask, ParsedBoard } from "./types";

const AUTO_BEGIN = "<!-- AI-TASKS:BEGIN -->";
const AUTO_END = "<!-- AI-TASKS:END -->";
const ALL_STATUSES: BoardStatus[] = [
  "Unassigned",
  "Todo",
  "Doing",
  "Review",
  "Done",
];

const TASK_BEGIN_RE =
  /<!--\s*AI-TASKS:TASK\s+([0-9a-fA-F-]{8,})\s+BEGIN\s*-->/g;

function normalizeStatus(s: string): BoardStatus | null {
  const t = s.trim();
  if (t === "Unassigned") return "Unassigned";
  if (t === "Todo") return "Todo";
  if (t === "Doing") return "Doing";
  if (t === "Review") return "Review";
  if (t === "Done") return "Done";
  return null;
}

function parseTitleFromBlock(block: string): string {
  const lines = block.split("\n");
  for (const line of lines) {
    const m = line.match(/^>\s*\[![^\]]+\]\s*(.+)\s*$/);
    if (m?.[1]) return m[1].trim();
  }
  return "(Untitled)";
}

function parseTagsFromBlock(block: string): string[] {
  const lines = block.split("\n");
  for (const line of lines) {
    const m = line.match(/^>\s*tags::\s*(.+)\s*$/i);
    if (m?.[1]) {
      return m[1]
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
  }
  return [];
}

function parseStatusFromBlock(block: string): BoardStatus | null {
  const lines = block.split("\n");
  for (const line of lines) {
    const m = line.match(/^>\s*status::\s*(.+)\s*$/i);
    if (m?.[1]) return normalizeStatus(m[1]) ?? null;
  }
  return null;
}

function findAutoArea(content: string): { autoStart: number; autoEnd: number } {
  const beginIdx = content.indexOf(AUTO_BEGIN);
  const endIdx = content.indexOf(AUTO_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error(
      `Board is missing auto area markers (${AUTO_BEGIN} / ${AUTO_END}).`
    );
  }
  const autoStart = beginIdx + AUTO_BEGIN.length;
  const autoEnd = endIdx;
  return { autoStart, autoEnd };
}

function parseSections(content: string, autoStart: number, autoEnd: number): Map<BoardStatus, BoardSection> {
  const auto = content.slice(autoStart, autoEnd);
  const lines = auto.split("\n");

  // Track absolute offsets in the full content.
  let offset = autoStart;
  const headings: Array<{ status: BoardStatus; start: number; end: number }> = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("## ")) {
      const statusText = trimmed.slice(3).trim();
      const status = normalizeStatus(statusText);
      if (status) {
        const start = offset + line.indexOf("## ");
        const end = offset + line.length;
        headings.push({ status, start, end });
      }
    }
    offset += line.length + 1; // + newline
  }

  const sections = new Map<BoardStatus, BoardSection>();
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h) continue;
    const next = headings[i + 1];
    const sectionStart = h.end + 1; // after heading line newline
    const sectionEnd = next ? next.start : autoEnd;

    const sectionText = content.slice(sectionStart, sectionEnd);
    const tasks: BoardTask[] = [];

    TASK_BEGIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TASK_BEGIN_RE.exec(sectionText))) {
      const uuid = m[1];
      if (!uuid) continue;
      const beginRel = m.index;
      const beginAbs = sectionStart + beginRel;

      const endMarker = `<!-- AI-TASKS:TASK ${uuid} END -->`;
      const endRel = sectionText.indexOf(endMarker, beginRel);
      if (endRel === -1) continue;
      const endAbs = sectionStart + endRel + endMarker.length;

      // Expand to include following newline(s) for cleaner cut/paste.
      let endAbsExpanded = endAbs;
      while (endAbsExpanded < content.length && content[endAbsExpanded] === "\n") {
        endAbsExpanded += 1;
        // At most consume one blank line to avoid deleting too much.
        if (endAbsExpanded < content.length && content[endAbsExpanded] === "\n") {
          endAbsExpanded += 1;
        }
        break;
      }

      const rawBlock = content.slice(beginAbs, endAbsExpanded);
      const parsedStatus = parseStatusFromBlock(rawBlock) ?? h.status;
      const title = parseTitleFromBlock(rawBlock);
      const tags = parseTagsFromBlock(rawBlock);

      tasks.push({
        uuid,
        title,
        status: parsedStatus,
        tags,
        rawBlock,
        start: beginAbs,
        end: endAbsExpanded,
      });
    }

    sections.set(h.status, {
      status: h.status,
      headingStart: h.start,
      headingEnd: h.end,
      sectionStart,
      sectionEnd,
      tasks,
    });
  }

  return sections;
}

export function parseBoard(content: string): ParsedBoard {
  const { autoStart, autoEnd } = findAutoArea(content);
  const sections = parseSections(content, autoStart, autoEnd);
  return { content, autoStart, autoEnd, sections };
}

function ensureStatusSections(content: string): string {
  const { autoStart, autoEnd } = findAutoArea(content);
  const sections = parseSections(content, autoStart, autoEnd);
  const missing = ALL_STATUSES.filter((s) => !sections.has(s));
  if (missing.length === 0) return content;

  const lines: string[] = [];
  for (const status of ALL_STATUSES) {
    if (!missing.includes(status)) continue;
    lines.push(`## ${status}`, "");
  }
  let insertion = lines.join("\n");
  if (!insertion.endsWith("\n")) insertion += "\n";

  let prefix = content.slice(0, autoEnd);
  const suffix = content.slice(autoEnd);
  if (prefix.length > 0 && !prefix.endsWith("\n")) {
    prefix += "\n";
  }

  return prefix + insertion + suffix;
}

function rewriteStatusField(block: string, newStatus: BoardStatus): string {
  const lines = block.split("\n");
  let changed = false;
  const out = lines.map((line) => {
    const m = line.match(/^>\s*status::\s*(.+)\s*$/i);
    if (!m) return line;
    changed = true;
    return `> status:: ${newStatus}`;
  });
  if (!changed) {
    // Insert a status field after the callout line if missing.
    for (let i = 0; i < out.length; i++) {
      const line = out[i];
      if (!line) continue;
      if (line.match(/^>\s*\[![^\]]+\]/)) {
        out.splice(i + 1, 0, `> status:: ${newStatus}`);
        break;
      }
    }
  }
  return out.join("\n");
}

function findInsertionPoint(
  parsed: ParsedBoard,
  toStatus: BoardStatus,
  beforeUuid: string | null
): number {
  const section = parsed.sections.get(toStatus);
  if (!section) {
    throw new Error(`Missing status section: ${toStatus}`);
  }

  if (beforeUuid) {
    for (const t of section.tasks) {
      if (t.uuid === beforeUuid) return t.start;
    }
  }

  const last = section.tasks.at(-1);
  if (last) return last.end;

  // Empty section: insert right after the heading line.
  return section.sectionStart;
}

export function moveTaskBlock(
  content: string,
  uuid: string,
  toStatus: BoardStatus,
  beforeUuid: string | null
): string {
  const normalized = ensureStatusSections(content);
  const parsed = parseBoard(normalized);

  let moving: BoardTask | null = null;
  let fromStatus: BoardStatus | null = null;
  for (const [status, section] of parsed.sections.entries()) {
    for (const t of section.tasks) {
      if (t.uuid === uuid) {
        moving = t;
        fromStatus = status;
        break;
      }
    }
    if (moving) break;
  }
  if (!moving || !fromStatus) throw new Error(`Task not found: ${uuid}`);

  // If dropping before itself, treat as append.
  const effectiveBefore = beforeUuid === uuid ? null : beforeUuid;

  let block = moving.rawBlock;
  if (fromStatus !== toStatus) {
    block = rewriteStatusField(block, toStatus);
  }

  // Remove the block first.
  let next = normalized.slice(0, moving.start) + normalized.slice(moving.end);

  // Re-parse after removal to get correct offsets for insertion.
  const parsedAfterRemoval = parseBoard(next);
  const insertAt = findInsertionPoint(parsedAfterRemoval, toStatus, effectiveBefore);

  const prefix = next.slice(0, insertAt);
  const suffix = next.slice(insertAt);
  const needsLeadingNl = prefix.length > 0 && !prefix.endsWith("\n");
  const needsTrailingNl = !block.endsWith("\n");
  const finalBlock =
    (needsLeadingNl ? "\n" : "") + block + (needsTrailingNl ? "\n" : "");

  next = prefix + finalBlock + suffix;
  return next;
}

export function insertTaskBlock(
  content: string,
  toStatus: BoardStatus,
  beforeUuid: string | null,
  block: string
): string {
  const normalized = ensureStatusSections(content);
  const parsed = parseBoard(normalized);
  const insertAt = findInsertionPoint(parsed, toStatus, beforeUuid);

  const prefix = normalized.slice(0, insertAt);
  const suffix = normalized.slice(insertAt);
  const needsLeadingNl = prefix.length > 0 && !prefix.endsWith("\n");
  const needsTrailingNl = !block.endsWith("\n");
  const finalBlock =
    (needsLeadingNl ? "\n" : "") + block + (needsTrailingNl ? "\n" : "");

  return prefix + finalBlock + suffix;
}

export function replaceTaskBlock(content: string, uuid: string, block: string): string {
  const parsed = parseBoard(content);

  let existing: BoardTask | null = null;
  for (const section of parsed.sections.values()) {
    for (const t of section.tasks) {
      if (t.uuid === uuid) {
        existing = t;
        break;
      }
    }
    if (existing) break;
  }
  if (!existing) throw new Error(`Task not found: ${uuid}`);

  const needsTrailingNl = !block.endsWith("\n");
  const finalBlock = block + (needsTrailingNl ? "\n" : "");

  return content.slice(0, existing.start) + finalBlock + content.slice(existing.end);
}

export function removeTaskBlock(content: string, uuid: string): { removed: BoardTask; next: string } {
  const parsed = parseBoard(content);

  let existing: BoardTask | null = null;
  for (const section of parsed.sections.values()) {
    for (const t of section.tasks) {
      if (t.uuid === uuid) {
        existing = t;
        break;
      }
    }
    if (existing) break;
  }
  if (!existing) throw new Error(`Task not found: ${uuid}`);

  const next = content.slice(0, existing.start) + content.slice(existing.end);
  return { removed: existing, next };
}
