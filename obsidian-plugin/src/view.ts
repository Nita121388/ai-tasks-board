import { ItemView, TFile, Vault, WorkspaceLeaf } from "obsidian";
import type AiTasksBoardPlugin from "./main";
import { moveTaskBlock, parseBoard } from "./board";
import type { BoardStatus, BoardTask } from "./types";

export const AI_TASKS_VIEW_TYPE = "ai-tasks-board-view";

const STATUSES: BoardStatus[] = ["Unassigned", "Todo", "Doing", "Review", "Done"];

function nowIsoForFilename(): string {
  // Avoid ':' for Windows compatibility.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function deriveHistoryPath(boardPath: string, ts: string): string {
  const baseName = boardPath.split("/").pop() ?? "Board.md";
  const stamped = baseName.replace(/\.md$/i, `.${ts}.md`);

  const idx = boardPath.lastIndexOf("/Boards/");
  if (idx !== -1) {
    const prefix = boardPath.slice(0, idx);
    return `${prefix}/History/Boards/${stamped}`;
  }

  // Fallback: put history next to the board file.
  const parent = boardPath.split("/").slice(0, -1).join("/");
  return `${parent}/History/${stamped}`;
}

async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter((p) => p.length > 0);
  let current = "";
  for (const p of parts) {
    current = current ? `${current}/${p}` : p;
    const existing = vault.getAbstractFileByPath(current);
    if (!existing) {
      await vault.createFolder(current);
    }
  }
}

export class AiTasksBoardView extends ItemView {
  plugin: AiTasksBoardPlugin;

  private statusFilter: BoardStatus | "All" = "All";
  private tagFilter: Set<string> = new Set();

  constructor(leaf: WorkspaceLeaf, plugin: AiTasksBoardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return AI_TASKS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI Tasks Board";
  }

  getIcon(): string {
    return "layout-list";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private async getBoardFile(): Promise<TFile | null> {
    const path = this.plugin.settings.boardPath;
    const abs = this.app.vault.getAbstractFileByPath(path);
    return abs instanceof TFile ? abs : null;
  }

  private async createDefaultBoard(): Promise<void> {
    const boardPath = this.plugin.settings.boardPath;
    const parent = boardPath.split("/").slice(0, -1).join("/");
    if (parent) await ensureFolder(this.app.vault, parent);

    const template = [
      "---",
      "schema: ai-tasks-board/v1",
      "board_id: ai-tasks-board",
      "statuses: [Unassigned, Todo, Doing, Review, Done]",
      "---",
      "",
      "# AI Tasks Board",
      "",
      "<!-- AI-TASKS:BEGIN -->",
      "## Unassigned",
      "",
      "## Todo",
      "",
      "## Doing",
      "",
      "## Review",
      "",
      "## Done",
      "<!-- AI-TASKS:END -->",
      "",
    ].join("\n");

    await this.app.vault.create(boardPath, template);
  }

  private async snapshotBoard(boardFile: TFile, content: string): Promise<void> {
    const ts = nowIsoForFilename();
    const historyPath = deriveHistoryPath(boardFile.path, ts);
    const historyFolder = historyPath.split("/").slice(0, -1).join("/");
    await ensureFolder(this.app.vault, historyFolder);
    await this.app.vault.create(historyPath, content);
  }

  private async writeBoard(boardFile: TFile, nextContent: string): Promise<void> {
    const current = await this.app.vault.read(boardFile);
    await this.snapshotBoard(boardFile, current);
    await this.app.vault.modify(boardFile, nextContent);
  }

  private renderHeader(root: HTMLElement, allTags: string[]): void {
    const header = root.createDiv({ cls: "ai-tasks-board-header" });

    header.createDiv({ cls: "ai-tasks-board-title", text: "AI Tasks Board" });

    const controls = header.createDiv({ cls: "ai-tasks-board-controls" });

    // Status filter
    const statusSelect = controls.createEl("select", {
      cls: "ai-tasks-board-select",
    });
    statusSelect.add(new Option("All statuses", "All"));
    for (const s of STATUSES) statusSelect.add(new Option(s, s));
    statusSelect.value = this.statusFilter;
    statusSelect.addEventListener("change", async () => {
      const v = statusSelect.value;
      this.statusFilter = v === "All" ? "All" : (v as BoardStatus);
      await this.render();
    });

    // Tags filter (checkboxes)
    const tagBox = controls.createDiv({ cls: "ai-tasks-board-tags" });
    const tagTitle = tagBox.createDiv({
      cls: "ai-tasks-board-tags-title",
      text: "Tags",
    });
    const tagList = tagBox.createDiv({ cls: "ai-tasks-board-tags-list" });
    if (allTags.length === 0) {
      tagList.createDiv({ cls: "ai-tasks-board-tags-empty", text: "(none)" });
    } else {
      for (const tag of allTags) {
        const label = tagList.createEl("label", { cls: "ai-tasks-tag" });
        const cb = label.createEl("input", { type: "checkbox" });
        cb.checked = this.tagFilter.has(tag);
        cb.addEventListener("change", async () => {
          if (cb.checked) this.tagFilter.add(tag);
          else this.tagFilter.delete(tag);
          await this.render();
        });
        label.createSpan({ text: tag });
      }
    }

    // Small affordance: click title to clear tag filter
    tagTitle.addEventListener("click", async () => {
      this.tagFilter.clear();
      await this.render();
    });
  }

  private shouldShowTask(t: BoardTask): boolean {
    if (this.statusFilter !== "All" && t.status !== this.statusFilter) return false;
    if (this.tagFilter.size > 0) {
      for (const tag of this.tagFilter) {
        if (t.tags.includes(tag)) return true;
      }
      return false;
    }
    return true;
  }

  private createCard(
    parent: HTMLElement,
    task: BoardTask,
    onMove: (uuid: string, toStatus: BoardStatus, beforeUuid: string | null) => Promise<void>
  ): HTMLElement {
    const card = parent.createDiv({
      cls: "ai-task-card",
      attr: { "data-uuid": task.uuid },
    });
    card.draggable = true;

    const top = card.createDiv({ cls: "ai-task-card-top" });
    top.createDiv({ cls: "ai-task-title", text: task.title });

    const statusSelect = top.createEl("select", { cls: "ai-task-status" });
    for (const s of STATUSES) statusSelect.add(new Option(s, s));
    statusSelect.value = task.status;
    statusSelect.addEventListener("change", async () => {
      await onMove(task.uuid, statusSelect.value as BoardStatus, null);
    });

    if (task.tags.length > 0) {
      const tags = card.createDiv({ cls: "ai-task-tags" });
      for (const tag of task.tags) {
        tags.createSpan({ cls: "ai-task-tag", text: tag });
      }
    }

    card.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("text/plain", task.uuid);
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

      const uuid =
        ev.dataTransfer?.getData("application/x-ai-task-uuid") ||
        ev.dataTransfer?.getData("text/plain");
      if (!uuid) return;

      const target = ev.target as HTMLElement | null;
      const beforeCard = target?.closest?.(".ai-task-card") as HTMLElement | null;
      const beforeUuid = beforeCard?.getAttribute("data-uuid") ?? null;

      await onMove(uuid, status, beforeUuid);
    });
  }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ai-tasks-board-root");

    const boardFile = await this.getBoardFile();
    if (!boardFile) {
      const empty = root.createDiv({ cls: "ai-tasks-board-empty" });
      empty.createDiv({
        text: `Board file not found: ${this.plugin.settings.boardPath}`,
      });
      const btn = empty.createEl("button", { text: "Create board" });
      btn.addEventListener("click", async () => {
        await this.createDefaultBoard();
        await this.render();
      });
      return;
    }

    const content = await this.app.vault.read(boardFile);
    let parsed;
    try {
      parsed = parseBoard(content);
    } catch (e) {
      const err = root.createDiv({ cls: "ai-tasks-board-error" });
      err.createDiv({
        text:
          e instanceof Error
            ? e.message
            : "Failed to parse Board.md (unknown error).",
      });
      return;
    }

    const allTags = Array.from(
      new Set(
        Array.from(parsed.sections.values()).flatMap((s) =>
          s.tasks.flatMap((t) => t.tags)
        )
      )
    ).sort();

    this.renderHeader(root, allTags);

    const columns = root.createDiv({ cls: "ai-tasks-board-columns" });

    const onMove = async (uuid: string, toStatus: BoardStatus, beforeUuid: string | null) => {
      const current = await this.app.vault.read(boardFile);
      const next = moveTaskBlock(current, uuid, toStatus, beforeUuid);
      await this.writeBoard(boardFile, next);
      await this.render();
    };

    for (const status of STATUSES) {
      const col = columns.createDiv({ cls: "ai-tasks-column" });
      col.createDiv({
        cls: "ai-tasks-column-title",
        text: status,
      });

      const list = col.createDiv({ cls: "ai-tasks-column-list" });
      this.attachColumnDnD(list, status, onMove);

      const section = parsed.sections.get(status);
      const tasks = (section?.tasks ?? []).filter((t) => this.shouldShowTask(t));
      for (const t of tasks) this.createCard(list, t, onMove);
    }
  }
}
