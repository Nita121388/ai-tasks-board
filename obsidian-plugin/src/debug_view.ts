import { ItemView, Notice, TFolder, WorkspaceLeaf } from "obsidian";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type AiTasksBoardPlugin from "./main";
import type { SessionsSyncOnceResult } from "./main";
import { RuntimeHttpError, randomRequestId, runtimeRequestJson } from "./runtime_http";

export const AI_TASKS_DEBUG_VIEW_TYPE = "ai-tasks-debug-view";

type RuntimeStatusPayload = {
  ok?: boolean;
  pid?: number;
  uptime_s?: number;
  version?: string;
};

type RuntimeState = {
  online: boolean;
  pid: number | null;
  uptimeSec: number | null;
  version: string | null;
  error: string | null;
};

type WatchTick = {
  ts: number | null;
  written: number;
  skipped_old: number;
  skipped_recent: number;
  skipped_existing: number;
  skipped_already_linked: number;
  linked_updates: number;
  created_unassigned: number;
  errors: number;
};

type PluginEvent = {
  ts: string;
  type: string;
  summary: string;
};

type StageStatus = "ok" | "warn" | "error" | "idle";

type StageItem = {
  name: string;
  status: StageStatus;
  detail: string;
};

function toIsoDate(ms: number): string {
  const d = new Date(ms);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function tailLines(text: string, maxLines: number): string[] {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length <= maxLines) return lines;
  return lines.slice(lines.length - maxLines);
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const raw = (line || "").trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(Math.max(0, Math.floor(n)));
}

export class AiTasksDebugView extends ItemView {
  private plugin: AiTasksBoardPlugin;
  private refreshTimer: number | null = null;
  private autoRefresh = true;
  private rendering = false;
  private syncingOnce = false;

  constructor(leaf: WorkspaceLeaf, plugin: AiTasksBoardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return AI_TASKS_DEBUG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.t("debug.view.title");
  }

  getIcon(): string {
    return "activity";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("ai-tasks-debug-root");
    await this.renderSafe();
    this.startAutoRefresh();
  }

  async onClose(): Promise<void> {
    this.stopAutoRefresh();
    this.contentEl.empty();
  }

  private startAutoRefresh(): void {
    if (!this.autoRefresh) return;
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setInterval(() => {
      void this.renderSafe();
    }, 5000);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer === null) return;
    window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private setAutoRefresh(enabled: boolean): void {
    this.autoRefresh = enabled;
    if (enabled) this.startAutoRefresh();
    else this.stopAutoRefresh();
  }

  private async fetchRuntimeState(): Promise<RuntimeState> {
    try {
      const resp = await runtimeRequestJson<RuntimeStatusPayload>(this.plugin, {
        path: "/v1/runtime/status",
        method: "GET",
        request_id: randomRequestId(),
        timeout_ms: 3000,
      });
      return {
        online: Boolean(resp.json.ok),
        pid: typeof resp.json.pid === "number" ? resp.json.pid : null,
        uptimeSec: typeof resp.json.uptime_s === "number" ? resp.json.uptime_s : null,
        version: typeof resp.json.version === "string" ? resp.json.version : null,
        error: null,
      };
    } catch (e) {
      const err = e instanceof RuntimeHttpError ? e : null;
      return {
        online: false,
        pid: null,
        uptimeSec: null,
        version: null,
        error: err ? err.message : e instanceof Error ? e.message : String(e),
      };
    }
  }

  private readLogLines(path: string | null, maxLines: number): string[] {
    if (!path) return [];
    if (!existsSync(path)) return [];
    try {
      const text = readFileSync(path, "utf-8");
      return tailLines(text, maxLines);
    } catch {
      return [];
    }
  }

  private parseLatestWatchTick(lines: string[]): WatchTick | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      const obj = parseJsonObject(lines[i] ?? "");
      if (!obj) continue;
      if (typeof obj.written !== "number") continue;
      if (typeof obj.skipped_old !== "number") continue;
      return {
        ts: typeof obj.ts === "number" ? obj.ts : null,
        written: obj.written,
        skipped_old: obj.skipped_old,
        skipped_recent: typeof obj.skipped_recent === "number" ? obj.skipped_recent : 0,
        skipped_existing: typeof obj.skipped_existing === "number" ? obj.skipped_existing : 0,
        skipped_already_linked: typeof obj.skipped_already_linked === "number" ? obj.skipped_already_linked : 0,
        linked_updates: typeof obj.linked_updates === "number" ? obj.linked_updates : 0,
        created_unassigned: typeof obj.created_unassigned === "number" ? obj.created_unassigned : 0,
        errors: typeof obj.errors === "number" ? obj.errors : 0,
      };
    }
    return null;
  }

  private parseSessionRefFromPath(path: string): string | null {
    for (const root of this.plugin.getSessionSearchRoots()) {
      const prefix = `${root.replace(/\/+$/g, "")}/`;
      if (!path.startsWith(prefix)) continue;
      const remain = path.slice(prefix.length);
      const parts = remain.split("/");
      if (parts.length < 2) return null;
      const source = parts[0] || "unknown";
      const id = (parts[1] || "").replace(/\.json$/i, "");
      if (!id) return null;
      return `${source}:${id}`;
    }
    return null;
  }

  private listSessionFiles() {
    const roots = this.plugin.getSessionSearchRoots().map((r) => `${r.replace(/\/+$/g, "")}/`);
    return this.app.vault
      .getFiles()
      .filter((f) => f.path.toLowerCase().endsWith(".json") && roots.some((r) => f.path.startsWith(r)))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  private async readRecentPluginEvents(limit = 24): Promise<PluginEvent[]> {
    const files = this.app.vault
      .getFiles()
      .filter((f) => /(^|\/)ai-tasks\.\d{4}-\d{2}-\d{2}\.jsonl$/i.test(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 2);

    const out: PluginEvent[] = [];
    for (const file of files) {
      try {
        const text = await this.app.vault.read(file);
        const lines = tailLines(text, 180);
        for (const line of lines) {
          const obj = parseJsonObject(line);
          if (!obj) continue;
          const type = typeof obj.type === "string" ? obj.type : "";
          const ts = typeof obj.ts === "string" ? obj.ts : "";
          if (!type || !ts) continue;

          let summary = "";
          if (typeof obj.error === "string" && obj.error) {
            summary = obj.error;
          } else if (typeof obj.http_status === "number") {
            summary = `http=${obj.http_status}`;
          } else if (typeof obj.latency_ms === "number") {
            summary = `latency=${obj.latency_ms}ms`;
          } else if (typeof obj.tasks_count === "number") {
            summary = `tasks=${obj.tasks_count}`;
          } else if (typeof obj.pid === "number") {
            summary = `pid=${obj.pid}`;
          } else if (typeof obj.ok === "boolean") {
            summary = `ok=${obj.ok}`;
          }
          out.push({ ts, type, summary });
        }
      } catch {
        // ignore single file parse failures
      }
    }

    out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return out.slice(0, Math.max(1, limit));
  }

  private buildStages(runtime: RuntimeState, watcherRunning: boolean, tick: WatchTick | null): StageItem[] {
    const stages: StageItem[] = [];

    const runtimeDetailParts: string[] = [];
    if (runtime.online) {
      runtimeDetailParts.push(this.plugin.t("debug.status.online"));
      if (runtime.pid !== null) runtimeDetailParts.push(`pid ${runtime.pid}`);
      if (runtime.version) runtimeDetailParts.push(`v${runtime.version}`);
      if (runtime.uptimeSec !== null) runtimeDetailParts.push(`${Math.floor(runtime.uptimeSec / 60)}m`);
    } else {
      runtimeDetailParts.push(this.plugin.t("debug.status.offline"));
      if (runtime.error) runtimeDetailParts.push(runtime.error);
    }
    stages.push({
      name: this.plugin.t("debug.stage.runtime"),
      status: runtime.online ? "ok" : "error",
      detail: runtimeDetailParts.join(" | "),
    });

    stages.push({
      name: this.plugin.t("debug.stage.watcher"),
      status: watcherRunning ? "ok" : "warn",
      detail: watcherRunning ? this.plugin.t("debug.status.running") : this.plugin.t("debug.status.stopped"),
    });

    if (!tick) {
      stages.push({
        name: this.plugin.t("debug.stage.poll"),
        status: "idle",
        detail: this.plugin.t("debug.stage.no_tick"),
      });
      stages.push({
        name: this.plugin.t("debug.stage.write"),
        status: "idle",
        detail: this.plugin.t("debug.stage.waiting_data"),
      });
      stages.push({
        name: this.plugin.t("debug.stage.link"),
        status: "idle",
        detail: this.plugin.t("debug.stage.waiting_data"),
      });
      return stages;
    }

    const pollSummary = [
      `written=${fmtNum(tick.written)}`,
      `old=${fmtNum(tick.skipped_old)}`,
      `recent=${fmtNum(tick.skipped_recent)}`,
      `existing=${fmtNum(tick.skipped_existing)}`,
    ].join(" | ");
    stages.push({
      name: this.plugin.t("debug.stage.poll"),
      status: tick.errors > 0 ? "error" : "ok",
      detail: pollSummary,
    });

    let writeStatus: StageStatus = "idle";
    let writeDetail = this.plugin.t("debug.stage.none_new");
    if (tick.errors > 0) {
      writeStatus = "error";
      writeDetail = this.plugin.t("debug.stage.failed");
    } else if (tick.written > 0) {
      writeStatus = "ok";
      writeDetail = this.plugin.t("debug.stage.written", { count: tick.written });
    } else if (tick.skipped_recent > 0) {
      writeStatus = "warn";
      writeDetail = this.plugin.t("debug.stage.wait_stable");
    } else if (tick.skipped_old > 0 && tick.skipped_existing === 0) {
      writeStatus = "warn";
      writeDetail = this.plugin.t("debug.stage.skipped_old");
    }
    stages.push({
      name: this.plugin.t("debug.stage.write"),
      status: writeStatus,
      detail: writeDetail,
    });

    let linkStatus: StageStatus = "idle";
    let linkDetail = this.plugin.t("debug.stage.no_link_change");
    if (tick.errors > 0) {
      linkStatus = "error";
      linkDetail = this.plugin.t("debug.stage.failed");
    } else if (tick.linked_updates > 0) {
      linkStatus = "ok";
      linkDetail = this.plugin.t("debug.stage.linked", { count: tick.linked_updates });
    } else if (tick.created_unassigned > 0) {
      linkStatus = "ok";
      linkDetail = this.plugin.t("debug.stage.created_unassigned", { count: tick.created_unassigned });
    }
    stages.push({
      name: this.plugin.t("debug.stage.link"),
      status: linkStatus,
      detail: linkDetail,
    });

    return stages;
  }

  private createSummaryCard(parent: HTMLElement, label: string, value: string, hint?: string): void {
    const card = parent.createDiv({ cls: "ai-tasks-debug-card" });
    card.createDiv({ cls: "ai-tasks-debug-card-label", text: label });
    card.createDiv({ cls: "ai-tasks-debug-card-value", text: value });
    if (hint && hint.trim()) {
      card.createDiv({ cls: "ai-tasks-debug-card-hint", text: hint });
    }
  }

  private extractNumber(obj: Record<string, unknown> | null, key: string): number | null {
    if (!obj) return null;
    const v = obj[key];
    return typeof v === "number" ? v : null;
  }

  private getSyncResultHint(result: SessionsSyncOnceResult): string {
    if (result.error) return result.error;
    if (result.code !== null) return `code=${result.code}`;
    return this.plugin.t("debug.stage.none");
  }

  private async renderSafe(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      await this.renderNow();
    } finally {
      this.rendering = false;
    }
  }

  private async renderNow(): Promise<void> {
    const root = this.contentEl;
    root.empty();

    const head = root.createDiv({ cls: "ai-tasks-debug-head" });
    head.createDiv({ cls: "ai-tasks-debug-title", text: this.plugin.t("debug.view.title") });
    const actions = head.createDiv({ cls: "ai-tasks-debug-actions" });

    const refreshBtn = actions.createEl("button", { text: this.plugin.t("debug.btn.refresh"), cls: "ai-tasks-debug-btn" });
    refreshBtn.addEventListener("click", () => {
      void this.renderSafe();
    });

    const syncBtn = actions.createEl("button", {
      text: this.syncingOnce ? this.plugin.t("debug.btn.syncing") : this.plugin.t("debug.btn.sync_once"),
      cls: "ai-tasks-debug-btn mod-cta",
    });
    syncBtn.addEventListener("click", () => {
      void (async () => {
        if (this.syncingOnce || this.plugin.isSessionsSyncRunning()) return;
        this.syncingOnce = true;
        await this.renderSafe();

        const result = await this.plugin.runSessionsSyncOnce();
        const written = this.extractNumber(result.parsed, "written");
        if (result.ok) {
          new Notice(this.plugin.t("debug.notice.sync_ok", { count: written ?? 0 }));
        } else {
          new Notice(this.plugin.t("debug.notice.sync_failed", { error: this.getSyncResultHint(result) }));
        }

        this.syncingOnce = false;
        await this.renderSafe();
      })();
    });

    const autoBtn = actions.createEl("button", {
      text: this.autoRefresh ? this.plugin.t("debug.btn.auto_on") : this.plugin.t("debug.btn.auto_off"),
      cls: "ai-tasks-debug-btn",
    });
    autoBtn.addEventListener("click", () => {
      this.setAutoRefresh(!this.autoRefresh);
      void this.renderSafe();
    });

    const [runtime, pluginEvents] = await Promise.all([this.fetchRuntimeState(), this.readRecentPluginEvents(24)]);

    const sessionFiles = this.listSessionFiles();
    const latest = sessionFiles[0] ?? null;
    const today = toIsoDate(Date.now());
    const todayCount = sessionFiles.filter((f) => toIsoDate(f.stat.mtime) === today).length;

    const primaryRoot = this.plugin.getPrimarySessionsRoot();
    const primaryExists = this.app.vault.getAbstractFileByPath(primaryRoot) instanceof TFolder;
    const watcherRunning = this.plugin.isSessionsWatcherRunning();

    const pluginDir = this.plugin.getPluginDirForDebug();
    const watchStdoutPath = pluginDir ? join(pluginDir, "sessions.stdout.log") : null;
    const watchStderrPath = pluginDir ? join(pluginDir, "sessions.stderr.log") : null;
    const stdoutLines = this.readLogLines(watchStdoutPath, 40);
    const stderrLines = this.readLogLines(watchStderrPath, 24);
    const tick = this.parseLatestWatchTick(stdoutLines);

    const summary = root.createDiv({ cls: "ai-tasks-debug-summary" });
    this.createSummaryCard(
      summary,
      this.plugin.t("debug.card.runtime"),
      runtime.online ? this.plugin.t("debug.status.online") : this.plugin.t("debug.status.offline"),
      runtime.online
        ? `pid=${runtime.pid ?? "-"} | v=${runtime.version ?? "-"}`
        : runtime.error || this.plugin.t("debug.stage.none")
    );
    this.createSummaryCard(
      summary,
      this.plugin.t("debug.card.watcher"),
      watcherRunning ? this.plugin.t("debug.status.running") : this.plugin.t("debug.status.stopped"),
      watcherRunning ? `pid=${this.plugin.getSessionsWatcherPid() ?? "-"}` : this.plugin.t("debug.stage.none")
    );
    this.createSummaryCard(
      summary,
      this.plugin.t("debug.card.session_dir"),
      primaryExists ? this.plugin.t("debug.status.exists") : this.plugin.t("debug.status.missing"),
      primaryRoot
    );
    this.createSummaryCard(summary, this.plugin.t("debug.card.total"), fmtNum(sessionFiles.length), "");
    this.createSummaryCard(summary, this.plugin.t("debug.card.today"), fmtNum(todayCount), today);
    this.createSummaryCard(
      summary,
      this.plugin.t("debug.card.latest"),
      latest ? this.parseSessionRefFromPath(latest.path) || latest.basename : this.plugin.t("debug.stage.none"),
      latest ? new Date(latest.stat.mtime).toLocaleString() : ""
    );

    const stageBox = root.createDiv({ cls: "ai-tasks-debug-section" });
    stageBox.createDiv({ cls: "ai-tasks-debug-section-title", text: this.plugin.t("debug.section.stage") });
    const stageList = stageBox.createDiv({ cls: "ai-tasks-debug-stage-list" });
    for (const st of this.buildStages(runtime, watcherRunning, tick)) {
      const row = stageList.createDiv({ cls: "ai-tasks-debug-stage-row" });
      row.createDiv({ cls: "ai-tasks-debug-stage-name", text: st.name });
      row.createDiv({ cls: `ai-tasks-debug-stage-badge is-${st.status}`, text: st.status.toUpperCase() });
      row.createDiv({ cls: "ai-tasks-debug-stage-detail", text: st.detail });
    }

    const eventsBox = root.createDiv({ cls: "ai-tasks-debug-section" });
    eventsBox.createDiv({ cls: "ai-tasks-debug-section-title", text: this.plugin.t("debug.section.events") });
    const eventsList = eventsBox.createDiv({ cls: "ai-tasks-debug-events" });
    if (!pluginEvents.length) {
      eventsList.createDiv({ cls: "ai-tasks-debug-empty", text: this.plugin.t("debug.stage.no_events") });
    } else {
      for (const ev of pluginEvents) {
        const row = eventsList.createDiv({ cls: "ai-tasks-debug-event-row" });
        row.createDiv({ cls: "ai-tasks-debug-event-ts", text: ev.ts });
        row.createDiv({ cls: "ai-tasks-debug-event-type", text: ev.type });
        if (ev.summary) {
          row.createDiv({ cls: "ai-tasks-debug-event-summary", text: ev.summary });
        }
      }
    }

    const watchBox = root.createDiv({ cls: "ai-tasks-debug-section" });
    watchBox.createDiv({ cls: "ai-tasks-debug-section-title", text: this.plugin.t("debug.section.watch_logs") });
    const watchGrid = watchBox.createDiv({ cls: "ai-tasks-debug-watch-grid" });

    const outCol = watchGrid.createDiv({ cls: "ai-tasks-debug-watch-col" });
    outCol.createDiv({ cls: "ai-tasks-debug-watch-title", text: this.plugin.t("debug.logs.stdout") });
    const outPre = outCol.createEl("pre", { cls: "ai-tasks-debug-pre" });
    outPre.textContent = stdoutLines.length ? stdoutLines.slice(-12).join("\n") : this.plugin.t("debug.stage.none");

    const errCol = watchGrid.createDiv({ cls: "ai-tasks-debug-watch-col" });
    errCol.createDiv({ cls: "ai-tasks-debug-watch-title", text: this.plugin.t("debug.logs.stderr") });
    const errPre = errCol.createEl("pre", { cls: "ai-tasks-debug-pre" });
    errPre.textContent = stderrLines.length ? stderrLines.slice(-12).join("\n") : this.plugin.t("debug.stage.none");
  }
}
