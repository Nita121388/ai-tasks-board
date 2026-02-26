import { Modal, Notice, TFile } from "obsidian";
import type AiTasksBoardPlugin from "./main";
import { appendAiTasksLog } from "./ai_log";
import { writeWithHistory } from "./board_fs";
import { insertTaskBlock, moveTaskBlock, normalizeEscapedNewlines, parseBoard, replaceTaskBlock } from "./board";
import type { BoardStatus, BoardTask } from "./types";

const STATUSES: BoardStatus[] = ["Unassigned", "Todo", "Doing", "Review", "Done"];

function randomUuid(): string {
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();

  // Fallback UUIDv4 generator (no dependencies).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function normalizeStatus(s: string | null | undefined): BoardStatus {
  const t = (s ?? "").trim();
  if (t === "Todo") return "Todo";
  if (t === "Doing") return "Doing";
  if (t === "Review") return "Review";
  if (t === "Done") return "Done";
  return "Unassigned";
}

function parseBodyFromBlock(block: string): string {
  const lines = block.replace(/\r\n/g, "\n").split("\n");

  const endIdx = lines.findIndex((l) =>
    /^<!--\s*AI-TASKS:TASK\s+[0-9a-fA-F-]{8,}\s+END\s*-->/.test(l.trim())
  );
  if (endIdx === -1) return "";

  const delimIdx = lines.findIndex((l) => l.trim() === ">");
  if (delimIdx === -1 || delimIdx >= endIdx) return "";

  const bodyLines = lines.slice(delimIdx + 1, endIdx);
  const out = bodyLines.map((l) => {
    const m = l.match(/^>\s?(.*)$/);
    return m ? m[1] : l;
  });
  // Trim a single trailing newline (textarea UX).
  return out.join("\n").replace(/\n$/, "");
}

function updateTaskBlockFields(beforeBlock: string, updates: {
  title: string;
  status: BoardStatus;
  tags: string[];
  body: string;
  updatedAtIso: string;
}): string {
  const lines = beforeBlock.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

  const endIdx = lines.findIndex((l) =>
    /^<!--\s*AI-TASKS:TASK\s+[0-9a-fA-F-]{8,}\s+END\s*-->/.test(l.trim())
  );
  if (endIdx === -1) throw new Error("Malformed task block (missing END marker).");

  // Update callout header title.
  const headerIdx = lines.findIndex((l) => /^>\s*\[![^\]]+\]/.test(l));
  if (headerIdx !== -1) {
    const m = lines[headerIdx]?.match(/^>\s*(\[\![^\]]+\])\s*(.*)$/);
    const callout = m?.[1] ?? "[!todo]";
    lines[headerIdx] = `> ${callout} ${updates.title || "(Untitled)"}`;
  }

  // Update or insert status.
  let statusIdx = lines.findIndex((l) => /^>\s*status::/i.test(l));
  if (statusIdx !== -1) {
    lines[statusIdx] = `> status:: ${updates.status}`;
  } else {
    const insertAt = headerIdx !== -1 ? headerIdx + 1 : 1;
    lines.splice(insertAt, 0, `> status:: ${updates.status}`);
    statusIdx = insertAt;
  }

  // Tags: update/insert/remove.
  const tagsIdx = lines.findIndex((l) => /^>\s*tags::/i.test(l));
  if (updates.tags.length > 0) {
    const tagLine = `> tags:: ${updates.tags.join(", ")}`;
    if (tagsIdx !== -1) lines[tagsIdx] = tagLine;
    else lines.splice(statusIdx + 1, 0, tagLine);
  } else if (tagsIdx !== -1) {
    lines.splice(tagsIdx, 1);
  }

  // updated:: field (single line, overwritten).
  const updatedIdx = lines.findIndex((l) => /^>\s*updated::/i.test(l));
  const updatedLine = `> updated:: ${updates.updatedAtIso}`;
  if (updatedIdx !== -1) {
    lines[updatedIdx] = updatedLine;
  } else {
    // Prefer right after created:: or status::.
    const createdIdx = lines.findIndex((l) => /^>\s*created::/i.test(l));
    const insertAt = createdIdx !== -1 ? createdIdx + 1 : statusIdx + 1;
    lines.splice(insertAt, 0, updatedLine);
  }

  // Rewrite body between the first delimiter ">" line and END marker.
  let delimIdx = lines.findIndex((l) => l.trim() === ">");
  if (delimIdx === -1 || delimIdx >= endIdx) {
    // Insert a delimiter right before END marker.
    delimIdx = endIdx;
    lines.splice(delimIdx, 0, ">");
  }

  // Recompute end index after potential inserts above.
  const newEndIdx = lines.findIndex((l) =>
    /^<!--\s*AI-TASKS:TASK\s+[0-9a-fA-F-]{8,}\s+END\s*-->/.test(l.trim())
  );
  if (newEndIdx === -1) throw new Error("Malformed task block (missing END marker).");

  const bodyOut: string[] = [];
  const rawBodyLines = (updates.body || "").replace(/\r\n/g, "\n").split("\n");
  for (const bl of rawBodyLines) {
    if (bl.trim() === "") bodyOut.push(">");
    else bodyOut.push(`> ${bl}`);
  }

  const head = lines.slice(0, delimIdx + 1);
  const tail = lines.slice(newEndIdx);
  return head.concat(bodyOut, tail).join("\n") + "\n";
}

function buildNewTaskBlock(opts: {
  uuid: string;
  title: string;
  status: BoardStatus;
  tags: string[];
  body: string;
  sourcePath?: string | null;
}): string {
  const created = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`<!-- AI-TASKS:TASK ${opts.uuid} BEGIN -->`);
  lines.push(`> [!todo] ${opts.title || "(Untitled)"}`);
  lines.push(`> status:: ${opts.status}`);
  if (opts.tags.length > 0) lines.push(`> tags:: ${opts.tags.join(", ")}`);
  lines.push(`> created:: ${created}`);
  lines.push(`> updated:: ${created}`);
  if (opts.sourcePath) lines.push(`> source:: [[${opts.sourcePath}]]`);
  lines.push(">");
  for (const bl of (opts.body || "").replace(/\r\n/g, "\n").split("\n")) {
    if (bl.trim() === "") lines.push(">");
    else lines.push(`> ${bl}`);
  }
  lines.push(`<!-- AI-TASKS:TASK ${opts.uuid} END -->`);
  return lines.join("\n") + "\n";
}

export class AiTasksEditTaskModal extends Modal {
  private plugin: AiTasksBoardPlugin;
  private boardFile: TFile;
  private task: BoardTask | null;
  private defaultStatus: BoardStatus;
  private sourcePath: string | null;
  private onDidWrite: () => void;

  constructor(
    plugin: AiTasksBoardPlugin,
    opts: {
      boardFile: TFile;
      task?: BoardTask | null;
      defaultStatus?: BoardStatus;
      sourcePath?: string | null;
      onDidWrite: () => void;
    }
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.boardFile = opts.boardFile;
    this.task = opts.task ?? null;
    this.defaultStatus = opts.defaultStatus ?? (this.task?.status ?? "Unassigned");
    this.sourcePath = opts.sourcePath ?? null;
    this.onDidWrite = opts.onDidWrite;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-tasks-edit-modal");

    const isEdit = !!this.task;
    contentEl.createEl("h2", { text: isEdit ? this.plugin.t("task_modal.title.edit") : this.plugin.t("task_modal.title.new") });

    const titleRow = contentEl.createDiv({ cls: "ai-tasks-form-row" });
    titleRow.createDiv({ cls: "ai-tasks-form-label", text: this.plugin.t("task_modal.label.title") });
    const titleInput = titleRow.createEl("input", { type: "text", cls: "ai-tasks-form-input" });
    titleInput.value = this.task?.title ?? "";

    const statusRow = contentEl.createDiv({ cls: "ai-tasks-form-row" });
    statusRow.createDiv({ cls: "ai-tasks-form-label", text: this.plugin.t("task_modal.label.status") });
    const statusSelect = statusRow.createEl("select", { cls: "ai-tasks-form-select" });
    for (const s of STATUSES) statusSelect.add(new Option(s, s));
    statusSelect.value = this.task?.status ?? this.defaultStatus;

    const tagsRow = contentEl.createDiv({ cls: "ai-tasks-form-row" });
    tagsRow.createDiv({ cls: "ai-tasks-form-label", text: this.plugin.t("task_modal.label.tags") });
    const tagsInput = tagsRow.createEl("input", { type: "text", cls: "ai-tasks-form-input" });
    tagsInput.placeholder = this.plugin.t("task_modal.placeholder.tags");
    tagsInput.value = (this.task?.tags ?? []).join(", ");

    const bodyRow = contentEl.createDiv({ cls: "ai-tasks-form-row" });
    bodyRow.createDiv({ cls: "ai-tasks-form-label", text: this.plugin.t("task_modal.label.body") });
    const bodyInput = bodyRow.createEl("textarea", { cls: "ai-tasks-form-textarea" });
    bodyInput.value = this.task ? parseBodyFromBlock(this.task.rawBlock) : "";

    const btns = contentEl.createDiv({ cls: "ai-tasks-form-buttons" });
    const saveBtn = btns.createEl("button", { text: this.plugin.t("btn.save"), cls: "mod-cta" });
    const cancelBtn = btns.createEl("button", { text: this.plugin.t("btn.cancel") });

    cancelBtn.addEventListener("click", () => this.close());
    saveBtn.addEventListener("click", () => {
      void this.save({
        title: titleInput.value,
        status: normalizeStatus(statusSelect.value),
        tagsRaw: tagsInput.value,
        body: bodyInput.value,
      });
    });
  }

  private async save(values: { title: string; status: BoardStatus; tagsRaw: string; body: string }): Promise<void> {
    try {
      const tags = values.tagsRaw
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const raw = await this.plugin.app.vault.read(this.boardFile);
      const norm = normalizeEscapedNewlines(raw);
      const content = norm.next;

      const parsed = parseBoard(content);
      const updatedAtIso = new Date().toISOString();

      let nextContent = content;

      if (this.task) {
        // Refresh current block from the latest file content.
        let existing: BoardTask | null = null;
        let fromStatus: BoardStatus | null = null;
        for (const [secStatus, sec] of parsed.sections.entries()) {
          for (const t of sec.tasks) {
            if (t.uuid === this.task.uuid) {
              existing = t;
              fromStatus = secStatus;
              break;
            }
          }
          if (existing) break;
        }
        if (!existing || !fromStatus) throw new Error(`Task not found: ${this.task.uuid}`);

        const updatedBlock = updateTaskBlockFields(existing.rawBlock, {
          title: values.title || "(Untitled)",
          status: values.status,
          tags,
          body: values.body ?? "",
          updatedAtIso,
        });

        nextContent = replaceTaskBlock(nextContent, existing.uuid, updatedBlock);
        if (fromStatus !== values.status) {
          nextContent = moveTaskBlock(nextContent, existing.uuid, values.status, null);
        }

        await writeWithHistory(this.plugin.app.vault, this.boardFile, nextContent);
        await appendAiTasksLog(this.plugin, {
          type: "task.edit",
          uuid: existing.uuid,
          from_status: fromStatus,
          status: values.status,
        });
      } else {
        const uuid = randomUuid();
        const block = buildNewTaskBlock({
          uuid,
          title: values.title || "(Untitled)",
          status: values.status,
          tags,
          body: values.body ?? "",
          sourcePath: this.sourcePath,
        });

        const firstUuid = parsed.sections.get(values.status)?.tasks?.[0]?.uuid ?? null;
        nextContent = insertTaskBlock(nextContent, values.status, firstUuid, block);
        await writeWithHistory(this.plugin.app.vault, this.boardFile, nextContent);
        await appendAiTasksLog(this.plugin, {
          type: "task.create",
          uuid,
          status: values.status,
        });
      }

      new Notice(this.plugin.t("task_modal.notice.saved"));
      this.close();
      this.onDidWrite();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(this.plugin.t("task_modal.notice.save_failed", { error: msg }));
    }
  }
}
