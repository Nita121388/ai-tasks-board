import { Modal, Notice, TFile } from "obsidian";
import type AiTasksBoardPlugin from "./main";
import type { AiModelConfig } from "./settings";
import { insertTaskBlock, normalizeEscapedNewlines, parseBoard } from "./board";
import { appendAiTasksLog } from "./ai_log";
import { ensureFolder, writeWithHistory } from "./board_fs";
import { RuntimeHttpError, randomRequestId, runtimeRequestJson } from "./runtime_http";
import type { BoardStatus } from "./types";

type SplitTask = {
  title: string;
  status?: string | null;
  tags?: string[] | null;
  body?: string | null;
};

type BoardSplitRequest = {
  text: string;
  instruction?: string | null;
  tag_presets?: string[];
  max_tasks?: number;
  ai_model?: AiModelConfig;
};

type BoardSplitResponse = {
  tasks: SplitTask[];
  reasoning?: string | null;
  confidence?: number | null;
  engine?: string | null;
  provider?: string | null;
  thread_id?: string | null;
  ai_fallback?: string | null;
};

const STATUSES: BoardStatus[] = ["Unassigned", "Todo", "Doing", "Review", "Done"];

function normalizeStatus(s: string | null | undefined): BoardStatus {
  const t = (s ?? "").trim();
  if (t === "Todo") return "Todo";
  if (t === "Doing") return "Doing";
  if (t === "Review") return "Review";
  if (t === "Done") return "Done";
  return "Unassigned";
}

function randomUuid(): string {
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildDefaultBoardMarkdown(): string {
  return [
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
}

async function getOrCreateBoardFile(plugin: AiTasksBoardPlugin): Promise<TFile> {
  const boardPath = plugin.settings.boardPath;
  const abs = plugin.app.vault.getAbstractFileByPath(boardPath);
  if (abs instanceof TFile) return abs;

  const parent = boardPath.split("/").slice(0, -1).join("/");
  if (parent) await ensureFolder(plugin.app.vault, parent);
  return await plugin.app.vault.create(boardPath, buildDefaultBoardMarkdown());
}

function asCalloutLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.map((l) => (l.length ? `> ${l}` : ">"));
}

function normalizeTags(tags: string[] | null | undefined): string[] {
  const raw = (tags ?? []).filter((t) => typeof t === "string");
  const cleaned = raw
    .flatMap((t) => t.split(/[,，]/g))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of cleaned) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function buildTaskBlock(opts: {
  uuid: string;
  title: string;
  status: BoardStatus;
  tags: string[];
  body: string;
  sourcePath?: string | null;
}): string {
  const created = new Date().toISOString();
  const title = (opts.title || "").trim() || "(Untitled)";
  const lines: string[] = [];
  lines.push(`<!-- AI-TASKS:TASK ${opts.uuid} BEGIN -->`);
  lines.push(`> [!todo] ${title}`);
  lines.push(`> status:: ${opts.status}`);
  if (opts.tags.length > 0) lines.push(`> tags:: ${opts.tags.join(", ")}`);
  lines.push(`> created:: ${created}`);
  if (opts.sourcePath) lines.push(`> source:: [[${opts.sourcePath}]]`);
  lines.push(">");
  if (opts.body.trim().length > 0) {
    lines.push(...asCalloutLines(opts.body));
  } else {
    lines.push(">");
  }
  lines.push(`<!-- AI-TASKS:TASK ${opts.uuid} END -->`);
  return lines.join("\n") + "\n";
}

export class AiTasksBulkImportModal extends Modal {
  private plugin: AiTasksBoardPlugin;
  private sourcePath: string | null;
  private text: string;
  private instruction: string = "";

  private boardFile: TFile | null = null;
  private tasks: SplitTask[] = [];
  private proposalMeta: Pick<BoardSplitResponse, "engine" | "provider" | "thread_id" | "ai_fallback" | "reasoning" | "confidence"> | null = null;

  private statusEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  constructor(plugin: AiTasksBoardPlugin, opts: { selection: string; sourcePath?: string | null }) {
    super(plugin.app);
    this.plugin = plugin;
    this.sourcePath = opts.sourcePath ?? null;
    this.text = opts.selection ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-tasks-bulk-import-modal");

    contentEl.createEl("h2", { text: this.plugin.t("bulk_modal.title") });

    const draftBox = contentEl.createDiv({ cls: "ai-tasks-draft-box" });
    draftBox.createDiv({ cls: "ai-tasks-draft-label", text: this.plugin.t("bulk_modal.label.text") });
    const draftInput = draftBox.createEl("textarea", { cls: "ai-tasks-draft-textarea" });
    draftInput.placeholder = this.plugin.t("bulk_modal.placeholder.text");
    draftInput.value = this.text;
    draftInput.addEventListener("input", () => {
      this.text = draftInput.value;
    });

    const instrBox = contentEl.createDiv({ cls: "ai-tasks-instr-box" });
    instrBox.createDiv({ cls: "ai-tasks-draft-label", text: this.plugin.t("bulk_modal.label.instruction") });
    const instrInput = instrBox.createEl("textarea", { cls: "ai-tasks-draft-textarea" });
    instrInput.placeholder = this.plugin.t("bulk_modal.placeholder.instruction");
    instrInput.value = this.instruction;
    instrInput.addEventListener("input", () => {
      this.instruction = instrInput.value;
    });

    const btnRow = contentEl.createDiv({ cls: "ai-tasks-draft-buttons" });
    const genBtn = btnRow.createEl("button", { text: this.plugin.t("btn.generate"), cls: "mod-cta" });
    const applyBtn = btnRow.createEl("button", { text: this.plugin.t("bulk_modal.btn.import_to_board") });

    this.statusEl = contentEl.createDiv({ cls: "ai-tasks-draft-status", text: "" });
    this.listEl = contentEl.createDiv({ cls: "ai-tasks-bulk-list" });

    genBtn.addEventListener("click", () => void this.generate());
    applyBtn.addEventListener("click", () => void this.apply());
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    if (!this.tasks.length) {
      this.listEl.createDiv({ cls: "ai-tasks-board-empty", text: this.plugin.t("bulk_modal.empty") });
      return;
    }

    for (const t of this.tasks) {
      const row = this.listEl.createDiv({ cls: "ai-tasks-bulk-row" });
      const title = (t.title || "").trim() || "(Untitled)";
      const status = normalizeStatus(t.status ?? "Unassigned");
      const tags = normalizeTags(t.tags);

      row.createDiv({ cls: "ai-tasks-bulk-title", text: title });
      row.createDiv({ cls: "ai-tasks-bulk-meta", text: `${status}${tags.length ? " | " + tags.join(", ") : ""}` });
    }
  }

  private async generate(): Promise<void> {
    try {
      this.setStatus(this.plugin.t("bulk_modal.status.generating"));

      this.boardFile = await getOrCreateBoardFile(this.plugin);

      const req: BoardSplitRequest = {
        text: this.text,
        instruction: this.instruction || null,
        tag_presets: this.plugin.getTagPresets(),
        max_tasks: 60,
        ai_model: this.plugin.getModelConfig(),
      };

      const requestId = randomRequestId();
      await appendAiTasksLog(this.plugin, {
        type: "board.split.request",
        request_id: requestId,
        text_len: req.text.length,
        instruction_len: (req.instruction ?? "").length,
        tag_presets_count: req.tag_presets?.length ?? 0,
        model_provider: req.ai_model?.provider ?? null,
        runtime_url: this.plugin.settings.runtimeUrl,
      });

      const respRaw = await runtimeRequestJson<BoardSplitResponse>(this.plugin, {
        path: "/v1/board/split",
        method: "POST",
        body: req,
        request_id: requestId,
      });
      const resp = respRaw.json;
      this.tasks = Array.isArray(resp.tasks) ? resp.tasks.slice(0, Math.max(1, req.max_tasks ?? 60)) : [];
      this.proposalMeta = {
        engine: resp.engine ?? null,
        provider: resp.provider ?? null,
        thread_id: resp.thread_id ?? null,
        ai_fallback: resp.ai_fallback ?? null,
        reasoning: resp.reasoning ?? null,
        confidence: resp.confidence ?? null,
      };

      await appendAiTasksLog(this.plugin, {
        type: "board.split.response",
        request_id: respRaw.meta.request_id,
        latency_ms: respRaw.meta.latency_ms,
        http_status: respRaw.meta.http_status,
        response_text_len: respRaw.meta.response_text_len,
        engine: resp.engine ?? null,
        provider: resp.provider ?? null,
        thread_id: resp.thread_id ?? null,
        ai_fallback: resp.ai_fallback ?? null,
        tasks_count: this.tasks.length,
        confidence: resp.confidence ?? null,
        reasoning: resp.reasoning ?? null,
      });

      this.renderList();

      const meta: string[] = [];
      if (resp.engine) meta.push(`engine=${resp.engine}`);
      if (resp.thread_id) meta.push(`thread=${resp.thread_id}`);
      if (resp.ai_fallback) meta.push(`ai_fallback=${resp.ai_fallback}`);
      if (resp.confidence != null) meta.push(`confidence=${resp.confidence.toFixed(2)}`);
      if (resp.reasoning) meta.push(resp.reasoning);
      this.setStatus(meta.length ? meta.join(" | ") : this.plugin.t("bulk_modal.status.ready", { count: this.tasks.length }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const meta = e instanceof RuntimeHttpError ? e.meta : null;
      await appendAiTasksLog(this.plugin, {
        type: "board.split.error",
        request_id: meta?.request_id ?? null,
        latency_ms: meta?.latency_ms ?? null,
        http_status: meta?.http_status ?? null,
        response_snip: meta?.response_snip ?? null,
        error: msg,
      });
      this.setStatus(this.plugin.t("bulk_modal.status.failed", { error: msg }));
      new Notice(this.plugin.t("bulk_modal.notice.generate_failed", { error: msg }));
    }
  }

  private async apply(): Promise<void> {
    if (!this.boardFile) {
      new Notice(this.plugin.t("bulk_modal.notice.board_not_ready"));
      return;
    }
    if (!this.tasks.length) {
      new Notice(this.plugin.t("bulk_modal.notice.generate_first"));
      return;
    }

    try {
      const raw = await this.plugin.app.vault.read(this.boardFile);
      const norm = normalizeEscapedNewlines(raw);
      let current = norm.next;
      if (norm.changed) {
        await writeWithHistory(this.plugin.app.vault, this.boardFile, norm.next);
        await appendAiTasksLog(this.plugin, { type: "board.normalize_escaped_newlines" });
      }

      const parsed = parseBoard(current);
      const firstUuidByStatus = new Map<BoardStatus, string | null>();
      for (const status of STATUSES) {
        const first = parsed.sections.get(status)?.tasks?.[0]?.uuid ?? null;
        firstUuidByStatus.set(status, first);
      }

      const created: Array<{ uuid: string; title: string; status: BoardStatus; tags: string[] }> = [];

      for (const t of this.tasks) {
        const title = (t.title || "").trim().slice(0, 120) || "(Untitled)";
        const status = normalizeStatus(t.status ?? "Unassigned");
        const tags = normalizeTags(t.tags);
        const body = String(t.body ?? "").trim();
        const uuid = randomUuid();

        const block = buildTaskBlock({ uuid, title, status, tags, body, sourcePath: this.sourcePath });
        current = insertTaskBlock(current, status, firstUuidByStatus.get(status) ?? null, block);
        created.push({ uuid, title, status, tags });
      }

      await writeWithHistory(this.plugin.app.vault, this.boardFile, current);
      await appendAiTasksLog(this.plugin, {
        type: "board.bulk_import.write",
        via: "bulk_import_modal",
        tasks_count: created.length,
        engine: this.proposalMeta?.engine ?? null,
        provider: this.proposalMeta?.provider ?? null,
        thread_id: this.proposalMeta?.thread_id ?? null,
      });

      new Notice(this.plugin.t("bulk_modal.notice.imported", { count: created.length }));
      this.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(this.plugin.t("bulk_modal.notice.import_failed", { error: msg }));
    }
  }
}
