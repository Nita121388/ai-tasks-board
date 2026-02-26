import { Editor, MarkdownView, Menu, Notice, Plugin, TFile, getLanguage } from "obsidian";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AiTasksBoardSettingTab, DEFAULT_SETTINGS, type AiModelConfig, type AiTasksBoardSettings } from "./settings";
import { AiTasksDraftModal } from "./draft_modal";
import { AiTasksBulkImportModal } from "./bulk_import_modal";
import { ensureFolder } from "./board_fs";
import { BoardNoteOverlayManager } from "./board_note_overlay";
import { AiTasksDiagnosticsModal, type DiagnosticsResult } from "./diagnostics_modal";
import { resolveLanguage, t as translate, type I18nKey, type ResolvedLanguage, type TemplateVars } from "./i18n";

type RuntimeStatusResponse = {
  ok?: boolean;
  pid?: number;
  uptime_s?: number;
  version?: string;
};

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/g, "") + path;
}

function splitArgs(input: string): string[] {
  if (!input) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const token = m[1] ?? m[2] ?? m[3];
    if (token) out.push(token);
  }
  return out;
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

export default class AiTasksBoardPlugin extends Plugin {
  settings: AiTasksBoardSettings;
  private runtimeProcess: ChildProcess | null = null;
  private runtimePid: number | null = null;
  private boardOverlay: BoardNoteOverlayManager | null = null;

  private getObsidianLanguageCode(): string {
    try {
      return getLanguage?.() || "en";
    } catch {
      return "en";
    }
  }

  getResolvedLanguage(): ResolvedLanguage {
    return resolveLanguage(this.settings?.uiLanguage, this.getObsidianLanguageCode());
  }

  t(key: I18nKey, vars?: TemplateVars): string {
    return translate(key, this.getResolvedLanguage(), vars);
  }

  private getPluginDir(): string | null {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const base = adapter?.getBasePath?.();
    if (!base) return null;
    return join(base, this.app.vault.configDir, "plugins", "ai-tasks-board");
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.boardOverlay = new BoardNoteOverlayManager(this);

    this.addCommand({
      id: "open-ai-tasks-board-note",
      name: this.t("cmd.open_board_note"),
      callback: async () => {
        const boardPath = this.settings.boardPath;
        const abs = this.app.vault.getAbstractFileByPath(boardPath);
        if (abs instanceof TFile) {
          await this.app.workspace.getLeaf().openFile(abs);
          return;
        }

        const parent = boardPath.split("/").slice(0, -1).join("/");
        if (parent) await ensureFolder(this.app.vault, parent);
        const f = await this.app.vault.create(boardPath, buildDefaultBoardMarkdown());
        await this.app.workspace.getLeaf().openFile(f);
      },
    });

    this.addCommand({
      id: "bulk-import-ai-tasks",
      name: this.t("cmd.bulk_import"),
      callback: () => {
        const sourcePath = this.app.workspace.getActiveFile()?.path ?? null;
        new AiTasksBulkImportModal(this, { selection: "", sourcePath }).open();
      },
    });

    // Board note overlay: render the draggable board UI directly in the note area
    // (both editor + reading modes), and keep raw Markdown hidden by default.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.requestOverlayUpdate()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.requestOverlayUpdate()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.requestOverlayUpdate()));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path !== this.settings.boardPath) return;
        this.boardOverlay?.requestRefresh();
      })
    );
    this.requestOverlayUpdate();

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        const sel = editor.getSelection();
        if (!sel || sel.trim().length === 0) return;

        menu.addItem((item) => {
          item
            .setTitle(this.t("menu.add_to_board"))
            .setIcon("plus")
            .onClick(() => {
              new AiTasksDraftModal(this, { mode: "create", selection: sel, sourcePath: view.file?.path }).open();
            });
        });

        menu.addItem((item) => {
          item
            .setTitle(this.t("menu.update_board_ai"))
            .setIcon("wand-2")
            .onClick(() => {
              new AiTasksDraftModal(this, { mode: "auto", selection: sel, sourcePath: view.file?.path }).open();
            });
        });

        menu.addItem((item) => {
          item
            .setTitle(this.t("menu.import_selection_ai"))
            .setIcon("list-plus")
            .onClick(() => {
              new AiTasksBulkImportModal(this, { selection: sel, sourcePath: view.file?.path }).open();
            });
        });
      })
    );

    this.addSettingTab(new AiTasksBoardSettingTab(this.app, this));
  }

  onunload(): void {
    this.boardOverlay?.dispose();
    this.boardOverlay = null;
  }

  requestOverlayUpdate(): void {
    void this.boardOverlay?.updateAll();
  }

  requestOverlayRefresh(): void {
    this.boardOverlay?.requestRefresh();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getModelConfig(): AiModelConfig {
    if (this.settings.modelProvider !== "openai-compatible") {
      return { provider: "codex-cli" };
    }

    const cfg: AiModelConfig = {
      provider: "openai-compatible",
      model: this.settings.modelName?.trim() || undefined,
      base_url: this.settings.modelBaseUrl?.trim() || undefined,
      api_key: this.settings.modelApiKey?.trim() || undefined,
      temperature: this.settings.modelTemperature,
      max_tokens: this.settings.modelMaxTokens,
      top_p: this.settings.modelTopP,
    };
    return cfg;
  }

  getTagPresets(): string[] {
    const raw = (this.settings.tagPresets || "").replace(/\r\n/g, "\n");
    const parts = raw
      .split(/\n|[,，]/g)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Dedup while preserving order.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  async startRuntime(): Promise<void> {
    if (this.runtimeProcess && this.runtimeProcess.exitCode === null) {
      new Notice(this.t("notice.runtime.already_running"));
      return;
    }

    const cmd = this.settings.runtimeCommand.trim();
    if (!cmd) {
      new Notice(this.t("notice.runtime.command_empty"));
      return;
    }

    const args = splitArgs(this.settings.runtimeArgs || "");
    const cwd = this.settings.runtimeCwd.trim() || undefined;

    try {
      const child = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        shell: false,
      });
      this.runtimeProcess = child;
      this.runtimePid = child.pid ?? null;

      const logDir = this.getPluginDir();
      if (logDir) {
        try {
          mkdirSync(logDir, { recursive: true });
          const stdoutPath = join(logDir, "runtime.stdout.log");
          const stderrPath = join(logDir, "runtime.stderr.log");
          child.stdout?.on("data", (buf) => {
            appendFileSync(stdoutPath, buf.toString());
          });
          child.stderr?.on("data", (buf) => {
            appendFileSync(stderrPath, buf.toString());
          });
          console.info(`[ai-tasks-board] runtime logs: ${stdoutPath} / ${stderrPath}`);
        } catch (e) {
          console.error("[ai-tasks-board] failed to init runtime log files", e);
        }
      }

      child.on("exit", () => {
        this.runtimeProcess = null;
        this.runtimePid = null;
      });
      child.on("error", (err) => {
        new Notice(this.t("notice.runtime.start_failed", { error: err.message }));
      });

      new Notice(child.pid ? this.t("notice.runtime.starting_pid", { pid: child.pid }) : this.t("notice.runtime.starting"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(this.t("notice.runtime.start_failed", { error: msg }));
    }
  }

  async stopRuntime(): Promise<void> {
    let requested = false;

    if (await this.requestRuntimeShutdown()) {
      requested = true;
    }

    if (this.runtimeProcess && this.runtimeProcess.exitCode === null) {
      this.runtimeProcess.kill();
      requested = true;
    }

    if (requested) {
      new Notice(this.t("notice.runtime.stop_requested"));
    } else {
      new Notice(this.t("notice.runtime.not_running"));
    }
  }

  async runTestAi(): Promise<void> {
    const url = joinUrl(this.settings.runtimeUrl, "/v1/board/propose");
    const req = {
      mode: "create" as const,
      draft:
        this.getResolvedLanguage() === "zh-CN"
          ? "这是一个诊断测试请求：请生成一个标题为“Test AI OK”的任务（不会写入文件）。"
          : "This is a diagnostic request: please propose a task titled 'Test AI OK' (no writes).",
      instruction: null,
      tasks: [],
      ai_model: this.getModelConfig(),
      tag_presets: this.getTagPresets(),
    };

    const started = Date.now();
    const result: DiagnosticsResult = {
      kind: "ai",
      url,
      latency_ms: 0,
      request: req,
      ok: false,
    };

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const text = await resp.text().catch(() => "");
      result.latency_ms = Math.max(0, Date.now() - started);
      result.http_status = resp.status;
      if (!resp.ok) {
        result.error = text || `HTTP ${resp.status}`;
      } else {
        result.ok = true;
        try {
          result.response = JSON.parse(text);
        } catch {
          result.ok = false;
          result.error = "invalid_json";
          result.response = text;
        }
      }
    } catch (e) {
      result.latency_ms = Math.max(0, Date.now() - started);
      result.error = e instanceof Error ? e.message : String(e);
    }

    new AiTasksDiagnosticsModal(this, result).open();
  }

  async runTestAgent(): Promise<void> {
    const url = joinUrl(this.settings.runtimeUrl, "/v1/agent/ask");
    const req = {
      prompt:
        this.getResolvedLanguage() === "zh-CN"
          ? "这是一个诊断测试请求：请只回复 OK。"
          : "This is a diagnostic request: reply with OK only.",
      include_memory: false,
      record_memory: false,
      timeout_s: 60,
    };

    const started = Date.now();
    const result: DiagnosticsResult = {
      kind: "agent",
      url,
      latency_ms: 0,
      request: req,
      ok: false,
    };

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const text = await resp.text().catch(() => "");
      result.latency_ms = Math.max(0, Date.now() - started);
      result.http_status = resp.status;
      if (!resp.ok) {
        result.error = text || `HTTP ${resp.status}`;
      } else {
        result.ok = true;
        try {
          result.response = JSON.parse(text);
        } catch {
          result.ok = false;
          result.error = "invalid_json";
          result.response = text;
        }
      }
    } catch (e) {
      result.latency_ms = Math.max(0, Date.now() - started);
      result.error = e instanceof Error ? e.message : String(e);
    }

    new AiTasksDiagnosticsModal(this, result).open();
  }

  async refreshRuntimeStatus(): Promise<string> {
    const status = await this.fetchRuntimeStatus();
    const online = status?.ok;
    let text = online ? this.t("runtime.status.online") : this.t("runtime.status.offline");
    if (online && status?.pid) {
      text += ` (pid ${status.pid})`;
    }
    if (online && typeof status?.uptime_s === "number") {
      const mins = Math.floor(status.uptime_s / 60);
      text += ` ${this.t("runtime.status.uptime", { mins })}`;
    }
    if (this.runtimeProcess && this.runtimeProcess.exitCode === null && this.runtimePid) {
      text += ` | ${this.t("runtime.status.local_pid", { pid: this.runtimePid })}`;
    }
    return text;
  }

  private async fetchRuntimeStatus(): Promise<RuntimeStatusResponse | null> {
    const url = joinUrl(this.settings.runtimeUrl, "/v1/runtime/status");
    try {
      const resp = await fetch(url, { method: "GET" });
      if (!resp.ok) return null;
      return (await resp.json()) as RuntimeStatusResponse;
    } catch {
      return null;
    }
  }

  private async requestRuntimeShutdown(): Promise<boolean> {
    const url = joinUrl(this.settings.runtimeUrl, "/v1/runtime/shutdown");
    try {
      const resp = await fetch(url, { method: "POST" });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
