import { Modal, Notice, TFile } from "obsidian";
import { existsSync, readdirSync, type Dirent } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
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

type LocalSessionInfo = {
  rootPath: string;
  available: boolean;
  totalCount: number;
  todayCount: number;
  latestSessionId: string | null;
  latestTime: string | null;
};

const STATUSES: BoardStatus[] = ["Unassigned", "Todo", "Doing", "Review", "Done"];
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/i;
const SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function safeReadDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function extractSessionId(name: string): string | null {
  const m = name.match(SESSION_ID_RE);
  return m?.[1]?.toLowerCase() ?? null;
}

function parseRolloutTime(name: string): string | null {
  const m = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

function collectLocalSessionInfo(now = new Date()): LocalSessionInfo {
  const rootPath = join(homedir(), ".codex", "sessions");
  if (!existsSync(rootPath)) {
    return {
      rootPath,
      available: false,
      totalCount: 0,
      todayCount: 0,
      latestSessionId: null,
      latestTime: null,
    };
  }

  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const todayRel = `${yyyy}/${mm}/${dd}/`;

  let totalCount = 0;
  let todayCount = 0;
  let latestKey = "";

  const years = safeReadDir(rootPath).filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name));
  for (const y of years) {
    const yearPath = join(rootPath, y.name);
    const months = safeReadDir(yearPath).filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name));
    for (const m of months) {
      const monthPath = join(yearPath, m.name);
      const days = safeReadDir(monthPath).filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name));
      for (const d of days) {
        const dayRel = `${y.name}/${m.name}/${d.name}/`;
        const dayPath = join(monthPath, d.name);
        for (const f of safeReadDir(dayPath)) {
          if (!f.isFile() || !ROLLOUT_FILE_RE.test(f.name)) continue;
          totalCount += 1;
          if (dayRel === todayRel) todayCount += 1;
          const key = `${dayRel}${f.name}`;
          if (!latestKey || key > latestKey) latestKey = key;
        }
      }
    }
  }

  const latestFileName = latestKey ? basename(latestKey) : "";
  return {
    rootPath,
    available: true,
    totalCount,
    todayCount,
    latestSessionId: latestFileName ? extractSessionId(latestFileName) : null,
    latestTime: latestFileName ? parseRolloutTime(latestFileName) : null,
  };
}

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

  private autoRefreshOn = false;
  private autoRefreshTimer: number | null = null;
  private sessionInfoEl: HTMLElement | null = null;
  private sessionMetaEl: HTMLElement | null = null;
  private sessionAutoBtn: HTMLButtonElement | null = null;
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

    contentEl.createEl("h2", { cls: "ai-tasks-bulk-heading", text: this.plugin.t("bulk_modal.title") });
    contentEl.createDiv({ cls: "ai-tasks-bulk-subtitle", text: this.plugin.t("bulk_modal.subtitle") });

    const sessionCard = contentEl.createDiv({ cls: "ai-tasks-bulk-session-card" });
    const sessionHead = sessionCard.createDiv({ cls: "ai-tasks-bulk-session-head" });
    sessionHead.createDiv({ cls: "ai-tasks-bulk-session-title", text: this.plugin.t("bulk_modal.session.title") });
    const sessionActions = sessionHead.createDiv({ cls: "ai-tasks-bulk-session-actions" });
    const refreshBtn = sessionActions.createEl("button", {
      cls: "ai-tasks-bulk-session-refresh",
      text: this.plugin.t("bulk_modal.session.btn_refresh"),
    });
    this.sessionAutoBtn = sessionActions.createEl("button", {
      cls: "ai-tasks-bulk-session-refresh",
      text: this.getAutoRefreshBtnText(),
    });
    this.sessionMetaEl = sessionCard.createDiv({ cls: "ai-tasks-bulk-session-meta" });
    this.sessionInfoEl = sessionCard.createDiv({ cls: "ai-tasks-bulk-session-grid" });
    this.renderSessionInfo();
    refreshBtn.addEventListener("click", () => {
      this.renderSessionInfo();
      this.setStatus(this.plugin.t("bulk_modal.session.status_refreshed"));
    });
    this.sessionAutoBtn.addEventListener("click", () => this.toggleAutoRefresh());

    const formGrid = contentEl.createDiv({ cls: "ai-tasks-bulk-form-grid" });
    const draftBox = formGrid.createDiv({ cls: "ai-tasks-bulk-panel ai-tasks-bulk-panel-main" });
    draftBox.createDiv({ cls: "ai-tasks-bulk-label", text: this.plugin.t("bulk_modal.label.text") });
    const draftInput = draftBox.createEl("textarea", { cls: "ai-tasks-bulk-textarea ai-tasks-bulk-textarea-main" });
    draftInput.placeholder = this.plugin.t("bulk_modal.placeholder.text");
    draftInput.value = this.text;
    draftInput.addEventListener("input", () => {
      this.text = draftInput.value;
    });

    const instrBox = formGrid.createDiv({ cls: "ai-tasks-bulk-panel" });
    instrBox.createDiv({ cls: "ai-tasks-bulk-label", text: this.plugin.t("bulk_modal.label.instruction") });
    const instrInput = instrBox.createEl("textarea", { cls: "ai-tasks-bulk-textarea" });
    instrInput.placeholder = this.plugin.t("bulk_modal.placeholder.instruction");
    instrInput.value = this.instruction;
    instrInput.addEventListener("input", () => {
      this.instruction = instrInput.value;
    });

    const btnRow = contentEl.createDiv({ cls: "ai-tasks-bulk-actions" });
    const genBtn = btnRow.createEl("button", { text: this.plugin.t("btn.generate"), cls: "mod-cta" });
    const applyBtn = btnRow.createEl("button", { text: this.plugin.t("bulk_modal.btn.import_to_board") });

    this.statusEl = contentEl.createDiv({ cls: "ai-tasks-bulk-status", text: "" });
    this.listEl = contentEl.createDiv({ cls: "ai-tasks-bulk-list" });

    genBtn.addEventListener("click", () => void this.generate());
    applyBtn.addEventListener("click", () => void this.apply());
  }

  onClose(): void {
    this.stopAutoRefresh();
    this.contentEl.empty();
  }

  private getAutoRefreshBtnText(): string {
    return this.plugin.t(this.autoRefreshOn ? "bulk_modal.session.btn_auto_on" : "bulk_modal.session.btn_auto_off");
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.autoRefreshTimer = window.setInterval(() => {
      this.renderSessionInfo();
    }, 30_000);
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer == null) return;
    window.clearInterval(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
  }

  private toggleAutoRefresh(): void {
    this.autoRefreshOn = !this.autoRefreshOn;
    if (this.sessionAutoBtn) this.sessionAutoBtn.textContent = this.getAutoRefreshBtnText();
    if (this.autoRefreshOn) {
      this.renderSessionInfo();
      this.startAutoRefresh();
      this.setStatus(this.plugin.t("bulk_modal.session.status_auto_on"));
      return;
    }
    this.stopAutoRefresh();
    this.setStatus(this.plugin.t("bulk_modal.session.status_auto_off"));
  }

  private renderSessionMeta(now: Date): void {
    if (!this.sessionMetaEl) return;
    const ts = now.toLocaleString();
    this.sessionMetaEl.textContent = this.plugin.t("bulk_modal.session.last_updated", { ts });
  }

  private renderSessionInfo(): void {
    if (!this.sessionInfoEl) return;
    this.sessionInfoEl.empty();
    this.renderSessionMeta(new Date());

    const info = collectLocalSessionInfo();
    const addItem = (label: string, value: string, mono = false): void => {
      const item = this.sessionInfoEl?.createDiv({ cls: "ai-tasks-bulk-session-item" });
      if (!item) return;
      item.createDiv({ cls: "ai-tasks-bulk-session-label", text: label });
      item.createDiv({ cls: `ai-tasks-bulk-session-value${mono ? " is-mono" : ""}`, text: value });
    };

    addItem(this.plugin.t("bulk_modal.session.root"), info.rootPath, true);
    if (!info.available) {
      this.sessionInfoEl.createDiv({
        cls: "ai-tasks-bulk-session-note",
        text: this.plugin.t("bulk_modal.session.unavailable"),
      });
      return;
    }

    addItem(this.plugin.t("bulk_modal.session.total"), String(info.totalCount));
    addItem(this.plugin.t("bulk_modal.session.today"), String(info.todayCount));
    addItem(
      this.plugin.t("bulk_modal.session.latest_id"),
      info.latestSessionId ?? this.plugin.t("bulk_modal.session.none"),
      true
    );
    addItem(
      this.plugin.t("bulk_modal.session.latest_time"),
      info.latestTime ?? this.plugin.t("bulk_modal.session.none")
    );
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

      const head = row.createDiv({ cls: "ai-tasks-bulk-row-head" });
      head.createDiv({ cls: "ai-tasks-bulk-title", text: title });
      head.createDiv({ cls: "ai-tasks-bulk-chip", text: status });
      row.createDiv({
        cls: "ai-tasks-bulk-meta",
        text: tags.length ? tags.join(", ") : this.plugin.t("bulk_modal.meta.no_tags"),
      });
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
