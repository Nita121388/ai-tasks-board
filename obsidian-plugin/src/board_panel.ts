import { Notice, TFile, Vault } from "obsidian";
import type AiTasksBoardPlugin from "./main";
import { appendAiTasksLog } from "./ai_log";
import { moveTaskBlock, normalizeEscapedNewlines, parseBoard, removeTaskBlock } from "./board";
import type { BoardStatus, BoardTask } from "./types";
import { ensureFolder, writeWithHistory } from "./board_fs";
import { AiTasksEditTaskModal } from "./task_edit_modal";
import { AiTasksBulkImportModal } from "./bulk_import_modal";

const STATUSES: BoardStatus[] = ["Unassigned", "Todo", "Doing", "Review", "Done"];

type SessionInfo = {
  ref: string;
  summary: string | null;
  snippets: string[];
  missing: boolean;
};

type CapturedSessionInfo = {
  ref: string;
  summary: string | null;
  snippets: string[];
  endedAt: string | null;
  mtime: number;
};

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
  private selectedUuid: string | null = null;

  constructor(plugin: AiTasksBoardPlugin, boardFile: TFile) {
    this.plugin = plugin;
    this.boardFile = boardFile;
  }

  private async readBoardNormalized(): Promise<string> {
    const raw = await this.plugin.app.vault.read(this.boardFile);
    const norm = normalizeEscapedNewlines(raw);
    if (norm.changed) {
      await writeWithHistory(this.plugin.app.vault, this.boardFile, norm.next);
      new Notice(this.plugin.t("board.notice.fixed_escaped_newlines"));
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

  private parseSessionRef(ref: string): { source: string; id: string } | null {
    const raw = (ref || "").trim();
    if (!raw) return null;
    const idx = raw.indexOf(":");
    if (idx === -1) return null;
    const source = raw.slice(0, idx).trim();
    const id = raw.slice(idx + 1).trim();
    if (!source || !id) return null;
    return { source, id };
  }

  private async loadSessionInfos(refs: string[]): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    const vault = this.plugin.app.vault;

    for (const ref of refs) {
      const parsed = this.parseSessionRef(ref);
      if (!parsed) {
        out.push({ ref, summary: null, snippets: [], missing: true });
        continue;
      }
      const rel = `Sessions/${parsed.source}/${parsed.id}.json`;
      const abs = vault.getAbstractFileByPath(rel);
      if (!(abs instanceof TFile)) {
        out.push({ ref, summary: null, snippets: [], missing: true });
        continue;
      }

      try {
        const raw = await vault.read(abs);
        const data = JSON.parse(raw) as {
          summary?: unknown;
          snippets?: unknown;
        };
        const summary = typeof data.summary === "string" ? data.summary.trim() : "";
        const snippetsRaw = Array.isArray(data.snippets) ? data.snippets : [];
        const snippets: string[] = [];
        for (const sn of snippetsRaw.slice(0, 3)) {
          if (!sn || typeof sn !== "object") continue;
          const role = typeof (sn as { role?: unknown }).role === "string" ? String((sn as { role?: unknown }).role) : "";
          const text = typeof (sn as { text?: unknown }).text === "string" ? String((sn as { text?: unknown }).text) : "";
          const one = text.replace(/\s+/g, " ").trim();
          if (!one) continue;
          snippets.push(role ? `${role}: ${one}` : one);
        }

        out.push({
          ref,
          summary: summary || null,
          snippets,
          missing: false,
        });
      } catch {
        out.push({ ref, summary: null, snippets: [], missing: true });
      }
    }

    return out;
  }

  private async loadCapturedSessions(limit = 12): Promise<CapturedSessionInfo[]> {
    const files = this.plugin.app.vault
      .getFiles()
      .filter((f) => /^Sessions\/[^/]+\/[^/]+\.json$/i.test(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, Math.max(1, limit));

    const out: CapturedSessionInfo[] = [];
    for (const f of files) {
      const parts = f.path.split("/");
      const source = parts[1] ?? "unknown";
      const ref = `${source}:${f.basename}`;

      try {
        const raw = await this.plugin.app.vault.read(f);
        const data = JSON.parse(raw) as {
          summary?: unknown;
          snippets?: unknown;
          ended_at?: unknown;
          started_at?: unknown;
        };

        const summary = typeof data.summary === "string" ? data.summary.trim() : "";
        const snippetsRaw = Array.isArray(data.snippets) ? data.snippets : [];
        const snippets: string[] = [];
        for (const sn of snippetsRaw.slice(0, 4)) {
          if (!sn || typeof sn !== "object") continue;
          const role = typeof (sn as { role?: unknown }).role === "string" ? String((sn as { role?: unknown }).role) : "";
          const text = typeof (sn as { text?: unknown }).text === "string" ? String((sn as { text?: unknown }).text) : "";
          const one = text.replace(/\s+/g, " ").trim();
          if (!one) continue;
          snippets.push(role ? `${role}: ${one}` : one);
        }

        const endedAt =
          typeof data.ended_at === "string"
            ? data.ended_at
            : typeof data.started_at === "string"
              ? data.started_at
              : null;

        out.push({
          ref,
          summary: summary || null,
          snippets,
          endedAt,
          mtime: f.stat.mtime,
        });
      } catch {
        out.push({
          ref,
          summary: null,
          snippets: [],
          endedAt: null,
          mtime: f.stat.mtime,
        });
      }
    }

    return out.sort((a, b) => {
      const ta = a.endedAt ? Date.parse(a.endedAt) : a.mtime;
      const tb = b.endedAt ? Date.parse(b.endedAt) : b.mtime;
      const sa = Number.isNaN(ta) ? a.mtime : ta;
      const sb = Number.isNaN(tb) ? b.mtime : tb;
      return sb - sa;
    });
  }

  private formatSessionTime(ts: string | null, fallbackMtime: number): string {
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toLocaleString();
    }
    return new Date(fallbackMtime).toLocaleString();
  }

  private renderCapturedSessions(root: HTMLElement, infos: CapturedSessionInfo[]): void {
    const box = root.createDiv({ cls: "ai-tasks-captured-sessions" });
    const head = box.createDiv({ cls: "ai-tasks-captured-sessions-head" });
    head.createDiv({
      cls: "ai-tasks-captured-sessions-title",
      text: this.plugin.t("board.captured_sessions.title"),
    });
    head.createDiv({ cls: "ai-tasks-captured-sessions-count", text: String(infos.length) });

    const list = box.createDiv({ cls: "ai-tasks-captured-sessions-list" });
    if (!infos.length) {
      list.createDiv({
        cls: "ai-tasks-captured-session-empty",
        text: this.plugin.t("board.captured_sessions.empty"),
      });
      return;
    }

    for (const info of infos) {
      const row = list.createDiv({ cls: "ai-tasks-captured-session" });
      row.createDiv({ cls: "ai-tasks-captured-session-ref", text: info.ref });
      row.createDiv({
        cls: "ai-tasks-captured-session-time",
        text: this.plugin.t("board.captured_sessions.time", {
          ts: this.formatSessionTime(info.endedAt, info.mtime),
        }),
      });
      if (info.summary) {
        row.createDiv({ cls: "ai-tasks-captured-session-summary", text: info.summary });
      }
      if (info.snippets.length > 0) {
        const snip = row.createEl("pre", { cls: "ai-tasks-captured-session-snippets" });
        snip.textContent = info.snippets.join("\n");
      }
      if (!info.summary && info.snippets.length === 0) {
        row.createDiv({
          cls: "ai-tasks-captured-session-empty",
          text: this.plugin.t("board.task.sessions.empty"),
        });
      }
    }
  }

  private renderHeader(root: HTMLElement, allTags: string[], viewMode: "kanban" | "split" | "md"): void {
    const header = root.createDiv({ cls: "ai-tasks-board-header" });

    const left = header.createDiv({ cls: "ai-tasks-board-header-left" });
    left.createDiv({ cls: "ai-tasks-board-title", text: this.plugin.t("board.title") });

    const controls = header.createDiv({ cls: "ai-tasks-board-controls" });

    const viewSelect = controls.createEl("select", { cls: "ai-tasks-board-view-select" });
    viewSelect.add(new Option(this.plugin.t("board.view.kanban"), "kanban"));
    viewSelect.add(new Option(this.plugin.t("board.view.split"), "split"));
    viewSelect.add(new Option(this.plugin.t("board.view.md"), "md"));
    viewSelect.value = viewMode;
    viewSelect.addEventListener("change", () => {
      void (async () => {
        const v = viewSelect.value as "kanban" | "split" | "md";
        this.plugin.settings.boardLayout = v;
        await this.plugin.saveSettings();
        await this.render(root);
      })();
    });

    const importBtn = controls.createEl("button", { text: this.plugin.t("btn.import"), cls: "ai-tasks-board-import" });
    importBtn.addEventListener("click", () => {
      new AiTasksBulkImportModal(this.plugin, { selection: "", sourcePath: this.boardFile.path }).open();
    });

    if (viewMode === "md") return;

    const search = controls.createEl("input", {
      type: "search",
      cls: "ai-tasks-board-search",
      attr: { placeholder: this.plugin.t("board.search.placeholder") },
    });
    search.value = this.searchText;
    search.addEventListener("input", async () => {
      this.searchText = search.value;
      await this.render(root);
    });

    // Status filter
    const statusSelect = controls.createEl("select", { cls: "ai-tasks-board-select" });
    statusSelect.add(new Option(this.plugin.t("board.status_filter.all"), "All"));
    for (const s of STATUSES) statusSelect.add(new Option(s, s));
    statusSelect.value = this.statusFilter;
    statusSelect.addEventListener("change", async () => {
      const v = statusSelect.value;
      this.statusFilter = v === "All" ? "All" : (v as BoardStatus);
      await this.render(root);
    });

    // Tags filter (chips)
    const tagBox = controls.createDiv({ cls: "ai-tasks-board-tags" });
    const tagTitle = tagBox.createDiv({ cls: "ai-tasks-board-tags-title", text: this.plugin.t("board.tags.title") });
    const tagList = tagBox.createDiv({ cls: "ai-tasks-board-tags-list" });
    if (allTags.length === 0) {
      tagList.createDiv({ cls: "ai-tasks-board-tags-empty", text: this.plugin.t("board.tags.empty") });
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

  private extractBodyFromBlock(rawBlock: string): string {
    const lines = rawBlock.replace(/\r\n/g, "\n").split("\n");

    const beginRe = /^<!--\s*AI-TASKS:TASK\s+[0-9a-fA-F-]{8,}\s+BEGIN\s*-->\s*$/i;
    const endRe = /^<!--\s*AI-TASKS:TASK\s+[0-9a-fA-F-]{8,}\s+END\s*-->\s*$/i;

    let inBody = false;
    const out: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (beginRe.test(trimmed)) continue;
      if (endRe.test(trimmed)) break;

      if (!inBody) {
        if (trimmed === ">") {
          inBody = true;
        }
        continue;
      }

      if (line.startsWith(">")) {
        let t = line.slice(1);
        if (t.startsWith(" ")) t = t.slice(1);
        out.push(t);
      } else {
        out.push(line);
      }
    }

    if (out.length === 0) {
      // Fallback: strip common callout prefixes.
      for (const line of lines) {
        if (beginRe.test(line.trim()) || endRe.test(line.trim())) continue;
        if (line.startsWith(">")) {
          let t = line.slice(1);
          if (t.startsWith(" ")) t = t.slice(1);
          out.push(t);
        }
      }
    }

    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private createCard(
    parent: HTMLElement,
    task: BoardTask,
    onMove: (uuid: string, toStatus: BoardStatus, beforeUuid: string | null) => Promise<void>,
    onArchive: (uuid: string) => Promise<void>,
    onDelete: (uuid: string) => Promise<void>,
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

    const editBtn = actions.createEl("button", { cls: "ai-task-edit", text: this.plugin.t("btn.edit") });
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onEdit(task);
    });

    const deleteBtn = actions.createEl("button", { cls: "ai-task-delete", text: this.plugin.t("btn.delete") });
    deleteBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await onDelete(task.uuid);
    });

    if (task.status === "Done") {
      const archiveBtn = actions.createEl("button", { text: this.plugin.t("btn.archive"), cls: "ai-task-archive" });
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

  private attachSplitDnD(
    listEl: HTMLElement,
    status: BoardStatus,
    onMove: (uuid: string, toStatus: BoardStatus, beforeUuid: string | null) => Promise<void>
  ): void {
    listEl.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      listEl.classList.add("is-drop-target");
    });
    listEl.addEventListener("dragleave", () => {
      listEl.classList.remove("is-drop-target");
    });
    listEl.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      listEl.classList.remove("is-drop-target");

      const uuid = ev.dataTransfer?.getData("application/x-ai-task-uuid");
      if (!uuid) return;

      const target = ev.target as HTMLElement | null;
      const beforeRow = target?.closest?.(".ai-tasks-split-task") as HTMLElement | null;
      const beforeUuid = beforeRow?.getAttribute("data-uuid") ?? null;

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

    const viewMode =
      this.plugin.settings.boardLayout === "kanban"
        ? "kanban"
        : this.plugin.settings.boardLayout === "md"
          ? "md"
          : "split";

    let content: string;
    try {
      content = await this.readBoardNormalized();
    } catch (e) {
      const err = root.createDiv({ cls: "ai-tasks-board-error" });
      err.createDiv({ text: e instanceof Error ? e.message : this.plugin.t("board.md.read_failed") });
      return;
    }

    if (viewMode === "md") {
      this.renderHeader(root, [], viewMode);

      const box = root.createDiv({ cls: "ai-tasks-md-root" });
      const actions = box.createDiv({ cls: "ai-tasks-md-actions" });
      const reloadBtn = actions.createEl("button", { text: this.plugin.t("btn.reload") });
      const saveBtn = actions.createEl("button", { text: this.plugin.t("btn.save"), cls: "mod-cta" });

      const textarea = box.createEl("textarea", { cls: "ai-tasks-md-textarea" });
      textarea.value = content;

      reloadBtn.addEventListener("click", () => void this.render(root));
      saveBtn.addEventListener("click", () => {
        void (async () => {
          await writeWithHistory(this.plugin.app.vault, this.boardFile, textarea.value.replace(/\r\n/g, "\n"));
          await appendAiTasksLog(this.plugin, { type: "board.write", via: "md_view" });
          new Notice(this.plugin.t("board.md.saved_notice"));
          await this.render(root);
        })();
      });
      return;
    }

    let parsed;
    try {
      parsed = parseBoard(content);
    } catch (e) {
      // Still render the header so user can switch to MD view to fix formatting.
      this.renderHeader(root, [], viewMode);
      const err = root.createDiv({ cls: "ai-tasks-board-error" });
      err.createDiv({ text: e instanceof Error ? e.message : this.plugin.t("board.md.parse_failed") });
      err.createDiv({ text: this.plugin.t("board.md.tip_switch_md") });
      return;
    }

    const allTasks = Array.from(parsed.sections.values()).flatMap((s) => s.tasks);
    const allTags = extractAllTags(allTasks);
    this.renderHeader(root, allTags, viewMode);

    const onMove = async (uuid: string, toStatus: BoardStatus, beforeUuid: string | null) => {
      const current = await this.readBoardNormalized();
      const next = moveTaskBlock(current, uuid, toStatus, beforeUuid);
      await writeWithHistory(this.plugin.app.vault, this.boardFile, next);
      await appendAiTasksLog(this.plugin, { type: "task.move", uuid, status: toStatus, before_uuid: beforeUuid });
      await this.render(root);
    };

    const onArchive = async (uuid: string) => {
      if (!window.confirm(this.plugin.t("board.confirm.archive"))) return;
      const current = await this.readBoardNormalized();
      const { removed, next } = removeTaskBlock(current, uuid);

      const dateStr = todayLocalDate();
      const archivePath = deriveArchivePath(this.plugin.settings.archiveFolderPath, dateStr);
      const archivedBlock = markTaskArchived(removed.rawBlock, new Date().toISOString());

      // Append to archive first to avoid losing the task if board write succeeds but archive fails.
      await this.appendToArchive(this.plugin.app.vault, archivePath, archivedBlock, dateStr);
      await writeWithHistory(this.plugin.app.vault, this.boardFile, next);

      new Notice(this.plugin.t("board.notice.archived_to", { path: archivePath }));
      await appendAiTasksLog(this.plugin, { type: "task.archive", uuid, archive_path: archivePath });
      await this.render(root);
    };

    const onDelete = async (uuid: string) => {
      if (!window.confirm(this.plugin.t("board.confirm.delete"))) return;
      const current = await this.readBoardNormalized();
      const { next } = removeTaskBlock(current, uuid);
      await writeWithHistory(this.plugin.app.vault, this.boardFile, next);
      new Notice(this.plugin.t("board.notice.deleted"));
      await appendAiTasksLog(this.plugin, { type: "task.delete", uuid });
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

    if (viewMode === "kanban") {
      const columns = root.createDiv({ cls: "ai-tasks-board-columns" });
      for (const status of STATUSES) {
        const col = columns.createDiv({ cls: "ai-tasks-column" });
        const head = col.createDiv({ cls: "ai-tasks-column-head" });
        head.createDiv({ cls: "ai-tasks-column-title", text: status });
        const addBtn = head.createEl("button", { cls: "ai-tasks-column-add", text: this.plugin.t("board.btn.add") });
        addBtn.addEventListener("click", () => onCreate(status));

        const list = col.createDiv({ cls: "ai-tasks-column-list" });
        this.attachColumnDnD(list, status, onMove);

        const section = parsed.sections.get(status);
        const tasks = (section?.tasks ?? []).filter((t) => this.shouldShowTask(t));
        for (const t of tasks) this.createCard(list, t, onMove, onArchive, onDelete, onEdit);
      }
    } else {
      // Split layout: left list (grouped by status) + right detail pane.
      const split = root.createDiv({ cls: "ai-tasks-board-split" });
      const leftPane = split.createDiv({ cls: "ai-tasks-board-split-left" });
      const rightPane = split.createDiv({ cls: "ai-tasks-board-split-right" });

      const taskByUuid = new Map<string, BoardTask>();
      for (const t of allTasks) taskByUuid.set(t.uuid, t);

      const visible: BoardTask[] = [];
      for (const status of STATUSES) {
        const section = parsed.sections.get(status);
        visible.push(...(section?.tasks ?? []).filter((t) => this.shouldShowTask(t)));
      }

      if (this.selectedUuid && !taskByUuid.has(this.selectedUuid)) {
        this.selectedUuid = null;
      }
      if (this.selectedUuid && !visible.some((t) => t.uuid === this.selectedUuid)) {
        this.selectedUuid = null;
      }
      if (!this.selectedUuid && visible.length > 0) {
        this.selectedUuid = visible[0]?.uuid ?? null;
      }

      for (const status of STATUSES) {
        const section = parsed.sections.get(status);
        const tasks = (section?.tasks ?? []).filter((t) => this.shouldShowTask(t));

        const secEl = leftPane.createDiv({ cls: "ai-tasks-split-section" });
        const secHead = secEl.createDiv({ cls: "ai-tasks-split-section-head" });
        secHead.createDiv({ cls: "ai-tasks-split-section-title", text: status });
        secHead.createDiv({ cls: "ai-tasks-split-section-count", text: String(tasks.length) });
        const addBtn = secHead.createEl("button", { cls: "ai-tasks-split-add", text: this.plugin.t("board.btn.add") });
        addBtn.addEventListener("click", () => onCreate(status));

        const list = secEl.createDiv({ cls: "ai-tasks-split-tasklist" });
        this.attachSplitDnD(list, status, onMove);

        for (const t of tasks) {
          const row = list.createDiv({ cls: "ai-tasks-split-task", attr: { "data-uuid": t.uuid } });
          if (t.uuid === this.selectedUuid) row.classList.add("is-selected");
          row.draggable = true;

          row.createDiv({ cls: "ai-tasks-split-task-title", text: t.title });
          if (t.tags.length > 0) {
            row.createDiv({ cls: "ai-tasks-split-task-tags", text: t.tags.join(", ") });
          }

          row.addEventListener("click", async (ev) => {
            if ((ev.target as HTMLElement | null)?.closest?.("select, button, a, input, textarea")) return;
            this.selectedUuid = t.uuid;
            await this.render(root);
          });

          row.addEventListener("dragstart", (ev) => {
            ev.dataTransfer?.setData("application/x-ai-task-uuid", t.uuid);
            ev.dataTransfer?.setDragImage(row, 8, 8);
            row.classList.add("is-dragging");
          });
          row.addEventListener("dragend", () => {
            row.classList.remove("is-dragging");
          });
        }
      }

      const selected = this.selectedUuid ? taskByUuid.get(this.selectedUuid) ?? null : null;
      if (!selected) {
        rightPane.createDiv({ cls: "ai-tasks-detail-empty", text: this.plugin.t("board.task.select_to_view") });
      } else {
        const detail = rightPane.createDiv({ cls: "ai-tasks-detail" });
        detail.createDiv({ cls: "ai-tasks-detail-title", text: selected.title });
        detail.createDiv({ cls: "ai-tasks-detail-uuid", text: selected.uuid });

        const meta = detail.createDiv({ cls: "ai-tasks-detail-meta" });
        const statusSelect = meta.createEl("select", { cls: "ai-tasks-detail-status" });
        for (const s of STATUSES) statusSelect.add(new Option(s, s));
        statusSelect.value = selected.status;
        statusSelect.addEventListener("change", async () => {
          await onMove(selected.uuid, statusSelect.value as BoardStatus, null);
        });

        const editBtn = meta.createEl("button", { text: this.plugin.t("btn.edit"), cls: "ai-tasks-detail-edit" });
        editBtn.addEventListener("click", () => onEdit(selected));

        const deleteBtn = meta.createEl("button", { text: this.plugin.t("btn.delete"), cls: "ai-tasks-detail-delete" });
        deleteBtn.addEventListener("click", async () => {
          await onDelete(selected.uuid);
        });

        if (selected.status === "Done") {
          const archiveBtn = meta.createEl("button", { text: this.plugin.t("btn.archive"), cls: "ai-tasks-detail-archive" });
          archiveBtn.addEventListener("click", async () => {
            await onArchive(selected.uuid);
          });
        }

        if (selected.tags.length > 0) {
          const tags = detail.createDiv({ cls: "ai-tasks-detail-tags" });
          for (const tag of selected.tags) tags.createSpan({ cls: "ai-task-tag", text: tag });
        }

        const body = detail.createDiv({ cls: "ai-tasks-detail-body" });
        const bodyText = this.extractBodyFromBlock(selected.rawBlock);
        const pre = body.createEl("pre", { cls: "ai-tasks-detail-body-pre" });
        pre.textContent = bodyText || this.plugin.t("board.task.no_details");

        const sessionRefs = selected.sessions ?? [];
        if (sessionRefs.length > 0) {
          const sessionsBox = detail.createDiv({ cls: "ai-tasks-detail-sessions" });
          sessionsBox.createDiv({
            cls: "ai-tasks-detail-section-title",
            text: this.plugin.t("board.task.sessions.title"),
          });

          const infos = await this.loadSessionInfos(sessionRefs);
          if (!infos.length) {
            sessionsBox.createDiv({ cls: "ai-tasks-detail-session-empty", text: this.plugin.t("board.task.sessions.empty") });
          } else {
            for (const info of infos) {
              const row = sessionsBox.createDiv({ cls: "ai-tasks-detail-session" });
              row.createDiv({ cls: "ai-tasks-detail-session-ref", text: info.ref });
              if (info.missing) {
                row.createDiv({
                  cls: "ai-tasks-detail-session-missing",
                  text: this.plugin.t("board.task.sessions.missing"),
                });
                continue;
              }
              if (info.summary) {
                row.createDiv({ cls: "ai-tasks-detail-session-summary", text: info.summary });
              }
              if (info.snippets.length > 0) {
                const snip = row.createEl("pre", { cls: "ai-tasks-detail-session-snippets" });
                snip.textContent = info.snippets.join("\n");
              }
              if (!info.summary && info.snippets.length === 0) {
                row.createDiv({
                  cls: "ai-tasks-detail-session-empty",
                  text: this.plugin.t("board.task.sessions.empty"),
                });
              }
            }
          }
        }
      }
    }

    const capturedSessions = await this.loadCapturedSessions(12);
    this.renderCapturedSessions(root, capturedSessions);
  }
}
