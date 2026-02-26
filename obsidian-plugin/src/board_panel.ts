import { Notice, TFile, Vault } from "obsidian";
import type AiTasksBoardPlugin from "./main";
import { appendAiTasksLog } from "./ai_log";
import { moveTaskBlock, normalizeEscapedNewlines, parseBoard, removeTaskBlock } from "./board";
import type { BoardStatus, BoardTask } from "./types";
import { ensureFolder, writeWithHistory } from "./board_fs";
import { AiTasksEditTaskModal } from "./task_edit_modal";

const STATUSES: BoardStatus[] = ["Unassigned", "Todo", "Doing", "Review", "Done"];

function todayLocalDate(): string {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function deriveArchivePath(archiveFolderPath: string, dateStr: string): string {
  const folder = (archiveFolderPath || "Archive").replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
}

function buildArchiveTemplate(dateStr: string): string {
  return [
    "---",
    "schema: ai-tasks-archive/v1",
    `date: ${dateStr}`,
    "---",
    "",
    `# Archive ${dateStr}`,
    "",
    "",
  ].join("\n");
}

function markTaskArchived(block: string, archivedAtIso: string): string {
  const lines = block.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const archivedIdx = lines.findIndex((l) => /^>\s*archived::/i.test(l));
  if (archivedIdx !== -1) {
    lines[archivedIdx] = `> archived:: ${archivedAtIso}`;
    return lines.join("\n") + "\n";
  }

  const createdIdx = lines.findIndex((l) => /^>\s*created::/i.test(l));
  const statusIdx = lines.findIndex((l) => /^>\s*status::/i.test(l));
  const headerIdx = lines.findIndex((l) => /^>\s*\[![^\]]+\]/.test(l));

  const insertAt =
    createdIdx !== -1
      ? createdIdx + 1
      : statusIdx !== -1
        ? statusIdx + 1
        : headerIdx !== -1
          ? headerIdx + 1
          : 1;
  lines.splice(insertAt, 0, `> archived:: ${archivedAtIso}`);
  return lines.join("\n") + "\n";
}

function extractAllTags(tasks: BoardTask[]): string[] {
  return Array.from(new Set(tasks.flatMap((t) => t.tags))).sort();
}

function matchesSearch(t: BoardTask, q: string): boolean {
  const qq = q.trim().toLowerCase();
  if (!qq) return true;
  return t.title.toLowerCase().includes(qq) || t.tags.some((tag) => tag.toLowerCase().includes(qq));
}

export class BoardPanel {
  private plugin: AiTasksBoardPlugin;
  private boardFile: TFile;

  private statusFilter: BoardStatus | "All" = "All";
  private tagFilter: Set<string> = new Set();
  private searchText: string = "";

  constructor(plugin: AiTasksBoardPlugin, boardFile: TFile) {
    this.plugin = plugin;
    this.boardFile = boardFile;
  }

  private async readBoardNormalized(): Promise<string> {
    const raw = await this.plugin.app.vault.read(this.boardFile);
    const norm = normalizeEscapedNewlines(raw);
    if (norm.changed) {
      await writeWithHistory(this.plugin.app.vault, this.boardFile, norm.next);
      new Notice("AI Tasks: fixed escaped newlines in Board.md.");
      await appendAiTasksLog(this.plugin, { type: "board.normalize_escaped_newlines" });
    }
    return norm.next;
  }

  private shouldShowTask(t: BoardTask): boolean {
    if (this.statusFilter !== "All" && t.status !== this.statusFilter) return false;
    if (this.tagFilter.size > 0) {
      for (const tag of this.tagFilter) {
        if (t.tags.includes(tag)) return true;
      }
      return false;
    }
    return matchesSearch(t, this.searchText);
  }

  private renderHeader(root: HTMLElement, allTags: string[]): void {
    const header = root.createDiv({ cls: "ai-tasks-board-header" });

    const left = header.createDiv({ cls: "ai-tasks-board-header-left" });
    left.createDiv({ cls: "ai-tasks-board-title", text: "AI Tasks Board" });

    const controls = header.createDiv({ cls: "ai-tasks-board-controls" });

    const search = controls.createEl("input", {
      type: "search",
      cls: "ai-tasks-board-search",
      attr: { placeholder: "Search title/tags..." },
    });
    search.value = this.searchText;
    search.addEventListener("input", async () => {
      this.searchText = search.value;
      await this.render(root);
    });

    // Status filter
    const statusSelect = controls.createEl("select", { cls: "ai-tasks-board-select" });
    statusSelect.add(new Option("All statuses", "All"));
    for (const s of STATUSES) statusSelect.add(new Option(s, s));
    statusSelect.value = this.statusFilter;
    statusSelect.addEventListener("change", async () => {
      const v = statusSelect.value;
      this.statusFilter = v === "All" ? "All" : (v as BoardStatus);
      await this.render(root);
    });

    // Tags filter (chips)
    const tagBox = controls.createDiv({ cls: "ai-tasks-board-tags" });
    const tagTitle = tagBox.createDiv({ cls: "ai-tasks-board-tags-title", text: "Tags" });
    const tagList = tagBox.createDiv({ cls: "ai-tasks-board-tags-list" });
    if (allTags.length === 0) {
      tagList.createDiv({ cls: "ai-tasks-board-tags-empty", text: "(none)" });
    } else {
      for (const tag of allTags) {
        const chip = tagList.createEl("button", { cls: "ai-tasks-tag-chip", text: tag });
        if (this.tagFilter.has(tag)) chip.classList.add("is-active");
        chip.addEventListener("click", async (ev) => {
          ev.preventDefault();
          if (this.tagFilter.has(tag)) this.tagFilter.delete(tag);
          else this.tagFilter.add(tag);
          await this.render(root);
        });
      }
    }

    tagTitle.addEventListener("click", async () => {
      this.tagFilter.clear();
      await this.render(root);
    });
  }

  private createCard(
    parent: HTMLElement,
    task: BoardTask,
    onMove: (uuid: string, toStatus: BoardStatus, beforeUuid: string | null) => Promise<void>,
    onArchive: (uuid: string) => Promise<void>,
    onEdit: (t: BoardTask) => void
  ): HTMLElement {
    const card = parent.createDiv({ cls: "ai-task-card", attr: { "data-uuid": task.uuid } });
    card.draggable = true;

    card.addEventListener("click", (ev) => {
      // Prevent clicks on nested controls from opening the edit modal.
      if ((ev.target as HTMLElement | null)?.closest?.("select, button, a, input, textarea")) return;
      onEdit(task);
    });

    const top = card.createDiv({ cls: "ai-task-card-top" });
    top.createDiv({ cls: "ai-task-title", text: task.title });

    const actions = top.createDiv({ cls: "ai-task-actions" });

    const statusSelect = actions.createEl("select", { cls: "ai-task-status" });
    for (const s of STATUSES) statusSelect.add(new Option(s, s));
    statusSelect.value = task.status;
    statusSelect.addEventListener("click", (ev) => ev.stopPropagation());
    statusSelect.addEventListener("change", async (ev) => {
      ev.stopPropagation();
      await onMove(task.uuid, statusSelect.value as BoardStatus, null);
    });

    const editBtn = actions.createEl("button", { cls: "ai-task-edit", text: "Edit" });
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onEdit(task);
    });

    if (task.status === "Done") {
      const archiveBtn = actions.createEl("button", { text: "Archive", cls: "ai-task-archive" });
      archiveBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await onArchive(task.uuid);
      });
    }

    if (task.tags.length > 0) {
      const tags = card.createDiv({ cls: "ai-task-tags" });
      for (const tag of task.tags) tags.createSpan({ cls: "ai-task-tag", text: tag });
    }

    card.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("application/x-ai-task-uuid", task.uuid);
      ev.dataTransfer?.setDragImage(card, 8, 8);
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
    });

    return card;
  }

  private attachColumnDnD(
    columnEl: HTMLElement,
    status: BoardStatus,
    onMove: (uuid: string, toStatus: BoardStatus, beforeUuid: string | null) => Promise<void>
  ): void {
    columnEl.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      columnEl.classList.add("is-drop-target");
    });
    columnEl.addEventListener("dragleave", () => {
      columnEl.classList.remove("is-drop-target");
    });
    columnEl.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      columnEl.classList.remove("is-drop-target");

      const uuid = ev.dataTransfer?.getData("application/x-ai-task-uuid");
      if (!uuid) return;

      const target = ev.target as HTMLElement | null;
      const beforeCard = target?.closest?.(".ai-task-card") as HTMLElement | null;
      const beforeUuid = beforeCard?.getAttribute("data-uuid") ?? null;

      await onMove(uuid, status, beforeUuid);
    });
  }

  private async appendToArchive(vault: Vault, archivePath: string, block: string, dateStr: string): Promise<void> {
    const parent = archivePath.split("/").slice(0, -1).join("/");
    if (parent) await ensureFolder(vault, parent);
    const abs = vault.getAbstractFileByPath(archivePath);
    if (abs instanceof TFile) {
      const prev = await vault.read(abs);
      const sep = prev.endsWith("\n") ? "\n" : "\n\n";
      await vault.modify(abs, prev + sep + block);
      return;
    }
    await vault.create(archivePath, buildArchiveTemplate(dateStr) + block);
  }

  async render(root: HTMLElement): Promise<void> {
    root.empty();
    root.addClass("ai-tasks-board-root");
    root.addClass("ai-tasks-board-inline");

    let content: string;
    try {
      content = await this.readBoardNormalized();
    } catch (e) {
      const err = root.createDiv({ cls: "ai-tasks-board-error" });
      err.createDiv({ text: e instanceof Error ? e.message : "Failed to read Board.md." });
      return;
    }

    let parsed;
    try {
      parsed = parseBoard(content);
    } catch (e) {
      const err = root.createDiv({ cls: "ai-tasks-board-error" });
      err.createDiv({
        text: e instanceof Error ? e.message : "Failed to parse Board.md (unknown error).",
      });
      return;
    }

    const allTasks = Array.from(parsed.sections.values()).flatMap((s) => s.tasks);
    const allTags = extractAllTags(allTasks);
    this.renderHeader(root, allTags);

    const columns = root.createDiv({ cls: "ai-tasks-board-columns" });

    const onMove = async (uuid: string, toStatus: BoardStatus, beforeUuid: string | null) => {
      const current = await this.readBoardNormalized();
      const next = moveTaskBlock(current, uuid, toStatus, beforeUuid);
      await writeWithHistory(this.plugin.app.vault, this.boardFile, next);
      await appendAiTasksLog(this.plugin, { type: "task.move", uuid, status: toStatus, before_uuid: beforeUuid });
      await this.render(root);
    };

    const onArchive = async (uuid: string) => {
      if (!window.confirm("Archive this task?")) return;
      const current = await this.readBoardNormalized();
      const { removed, next } = removeTaskBlock(current, uuid);

      const dateStr = todayLocalDate();
      const archivePath = deriveArchivePath(this.plugin.settings.archiveFolderPath, dateStr);
      const archivedBlock = markTaskArchived(removed.rawBlock, new Date().toISOString());

      // Append to archive first to avoid losing the task if board write succeeds but archive fails.
      await this.appendToArchive(this.plugin.app.vault, archivePath, archivedBlock, dateStr);
      await writeWithHistory(this.plugin.app.vault, this.boardFile, next);

      new Notice(`Archived task to ${archivePath}`);
      await appendAiTasksLog(this.plugin, { type: "task.archive", uuid, archive_path: archivePath });
      await this.render(root);
    };

    const onEdit = (t: BoardTask) => {
      new AiTasksEditTaskModal(this.plugin, {
        boardFile: this.boardFile,
        task: t,
        onDidWrite: () => {
          void this.render(root);
        },
      }).open();
    };

    const onCreate = (status: BoardStatus) => {
      new AiTasksEditTaskModal(this.plugin, {
        boardFile: this.boardFile,
        task: null,
        defaultStatus: status,
        onDidWrite: () => {
          void this.render(root);
        },
      }).open();
    };

    for (const status of STATUSES) {
      const col = columns.createDiv({ cls: "ai-tasks-column" });
      const head = col.createDiv({ cls: "ai-tasks-column-head" });
      head.createDiv({ cls: "ai-tasks-column-title", text: status });
      const addBtn = head.createEl("button", { cls: "ai-tasks-column-add", text: "+ Add" });
      addBtn.addEventListener("click", () => onCreate(status));

      const list = col.createDiv({ cls: "ai-tasks-column-list" });
      this.attachColumnDnD(list, status, onMove);

      const section = parsed.sections.get(status);
      const tasks = (section?.tasks ?? []).filter((t) => this.shouldShowTask(t));
      for (const t of tasks) this.createCard(list, t, onMove, onArchive, onEdit);
    }
  }
}

