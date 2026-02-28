import { Editor, MarkdownView, Menu, Notice, Plugin, TFile, getLanguage } from "obsidian";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { appendAiTasksLog } from "./ai_log";
import { AiTasksBoardSettingTab, DEFAULT_SETTINGS, type AiModelConfig, type AiTasksBoardSettings } from "./settings";
import { AiTasksDraftModal } from "./draft_modal";
import { AiTasksBulkImportModal } from "./bulk_import_modal";
import { ensureFolder } from "./board_fs";
import { BoardNoteOverlayManager } from "./board_note_overlay";
import { AiTasksDiagnosticsModal, type DiagnosticsResult } from "./diagnostics_modal";
import { resolveLanguage, t as translate, type I18nKey, type ResolvedLanguage, type TemplateVars } from "./i18n";
import { RuntimeHttpError, randomRequestId, runtimeRequestJson } from "./runtime_http";

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

type ParsedRuntimeUrl = { host: string; port: number };

function parseRuntimeUrl(raw: string): ParsedRuntimeUrl | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const host = u.hostname || "127.0.0.1";
    const port = u.port ? Number(u.port) : 17890;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function hasCliFlag(args: string[], flag: string): boolean {
  const lower = flag.toLowerCase();
  for (let i = 0; i < args.length; i++) {
    const a = (args[i] || "").toLowerCase();
    if (a === lower) return true;
    if (a.startsWith(lower + "=")) return true;
  }
  return false;
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
  private sessionsProcess: ChildProcess | null = null;
  private sessionsPid: number | null = null;
  private boardOverlay: BoardNoteOverlayManager | null = null;
  private autoStartPromise: Promise<void> | null = null;

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

  getPluginVersion(): string {
    return this.manifest?.version || "";
  }

  private getPluginDir(): string | null {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const base = adapter?.getBasePath?.();
    if (!base) return null;
    return join(base, this.app.vault.configDir, "plugins", "ai-tasks-board");
  }

  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    return adapter?.getBasePath?.() || null;
  }

  private getDefaultAgentDir(): string | null {
    try {
      return join(homedir(), ".ai-tasks-board", "agent");
    } catch {
      return null;
    }
  }

  private getBundledRuntimeCommand(): string | null {
    const pluginDir = this.getPluginDir();
    if (!pluginDir) return null;

    // When installed via the "bundle" zip, runtime binaries live under:
    //   .obsidian/plugins/ai-tasks-board/bin/<platform>-<arch>/ai-tasks-runtime[.exe]
    // This keeps plugin-only installs working (no bin/ folder present).
    const binName = process.platform === "win32" ? "ai-tasks-runtime.exe" : "ai-tasks-runtime";
    const candidates = [
      join(pluginDir, "bin", `${process.platform}-${process.arch}`, binName),
      join(pluginDir, "bin", process.platform, process.arch, binName),
      join(pluginDir, "bin", process.platform, binName),
      join(pluginDir, "bin", binName),
    ];

    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  private resolveRuntimeSpawnBase(): {
    cmd: string;
    cwd: string | undefined;
    env: Record<string, string>;
    bundledCmd: string | null;
    urlInfo: ParsedRuntimeUrl | null;
  } | null {
    const bundledCmd = this.getBundledRuntimeCommand();
    const isDefaultCmd = this.settings.runtimeCommand.trim() === DEFAULT_SETTINGS.runtimeCommand;
    let cmd = this.settings.runtimeCommand.trim();
    if ((!cmd || isDefaultCmd) && bundledCmd) {
      cmd = bundledCmd;
      if (process.platform !== "win32") {
        try {
          chmodSync(cmd, 0o755);
        } catch {
          // ignore
        }
      }
    }
    if (!cmd) return null;

    const pluginDir = this.getPluginDir();
    const cwd = this.settings.runtimeCwd.trim() || (cmd === bundledCmd ? pluginDir || undefined : undefined);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const urlInfo = parseRuntimeUrl(this.settings.runtimeUrl);
    if (urlInfo) {
      env.AI_TASKS_HOST = urlInfo.host;
      env.AI_TASKS_PORT = String(urlInfo.port);
    }
    const agentDir = this.settings.agentDir?.trim() || this.getDefaultAgentDir();
    if (agentDir) {
      env.AI_TASKS_AGENT_DIR = agentDir;
    }
    const codexBin = this.settings.codexCliPath?.trim();
    if (codexBin) {
      env.AI_TASKS_CODEX_BIN = codexBin;
    }
    return { cmd, cwd, env, bundledCmd, urlInfo };
  }

  private async autoStartRuntimeIfNeeded(): Promise<void> {
    if (!this.settings.autoStartRuntime) return;
    if (this.autoStartPromise) return;

    this.autoStartPromise = (async () => {
      await this.startRuntime();
    })().finally(() => {
      this.autoStartPromise = null;
    });

    await this.autoStartPromise;
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

    // Runtime auto-start: run in background after layout is ready.
    // - Avoids port conflicts by probing runtimeUrl first.
    // - Default enabled for "formal release" usability.
    this.app.workspace.onLayoutReady(() => {
      void this.autoStartRuntimeIfNeeded();
    });
  }

  onunload(): void {
    this.boardOverlay?.dispose();
    this.boardOverlay = null;

    // Best-effort cleanup: only kill the child process we started.
    if (this.runtimeProcess && this.runtimeProcess.exitCode === null) {
      try {
        this.runtimeProcess.kill();
      } catch {
        // ignore
      }
    }
    this.runtimeProcess = null;
    this.runtimePid = null;

    if (this.sessionsProcess && this.sessionsProcess.exitCode === null) {
      try {
        this.sessionsProcess.kill();
      } catch {
        // ignore
      }
    }
    this.sessionsProcess = null;
    this.sessionsPid = null;
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

  private async startSessionsWatcherIfNeeded(base: { cmd: string; cwd: string | undefined; env: Record<string, string> }): Promise<void> {
    if (this.sessionsProcess && this.sessionsProcess.exitCode === null) return;

    const vaultPath = this.getVaultBasePath();
    if (!vaultPath) {
      void appendAiTasksLog(this, { type: "sessions.watch.skip.no_vault_path" });
      return;
    }

    const args = ["sessions", "watch", vaultPath, "--board-path", this.settings.boardPath];
    void appendAiTasksLog(this, {
      type: "sessions.watch.start.request",
      cmd: base.cmd,
      args,
      cwd: base.cwd ?? null,
      vault: vaultPath,
      board_path: this.settings.boardPath,
    });

    const child = spawn(base.cmd, args, {
      cwd: base.cwd,
      windowsHide: true,
      shell: false,
      env: base.env,
    });
    this.sessionsProcess = child;
    this.sessionsPid = child.pid ?? null;

    const logDir = this.getPluginDir();
    let stdoutPath: string | null = null;
    let stderrPath: string | null = null;
    if (logDir) {
      try {
        mkdirSync(logDir, { recursive: true });
        stdoutPath = join(logDir, "sessions.stdout.log");
        stderrPath = join(logDir, "sessions.stderr.log");
        child.stdout?.on("data", (buf) => {
          if (stdoutPath) appendFileSync(stdoutPath, buf.toString());
        });
        child.stderr?.on("data", (buf) => {
          if (stderrPath) appendFileSync(stderrPath, buf.toString());
        });
      } catch (e) {
        void appendAiTasksLog(this, {
          type: "sessions.watch.logfiles_error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    void appendAiTasksLog(this, {
      type: "sessions.watch.start.spawned",
      pid: child.pid ?? null,
      stdout_log: stdoutPath,
      stderr_log: stderrPath,
    });

    child.on("exit", (code, signal) => {
      void appendAiTasksLog(this, {
        type: "sessions.watch.process.exit",
        pid: child.pid ?? null,
        code: code ?? null,
        signal: signal ?? null,
      });
      this.sessionsProcess = null;
      this.sessionsPid = null;
    });

    child.on("error", (err) => {
      void appendAiTasksLog(this, {
        type: "sessions.watch.process.error",
        pid: child.pid ?? null,
        error: err instanceof Error ? err.message : String(err),
        code: (err as unknown as { code?: string }).code ?? null,
      });
    });
  }

  private stopSessionsWatcher(): boolean {
    if (!this.sessionsProcess || this.sessionsProcess.exitCode !== null) return false;
    this.sessionsProcess.kill();
    void appendAiTasksLog(this, { type: "sessions.watch.stop.killed", pid: this.sessionsPid ?? null });
    return true;
  }

  async startRuntime(): Promise<void> {
    const online = await this.fetchRuntimeStatus();
    const base = this.resolveRuntimeSpawnBase();
    if (online?.ok) {
      void appendAiTasksLog(this, {
        type: "runtime.start.skip.online",
        runtime_url: this.settings.runtimeUrl,
        pid: online.pid ?? null,
        version: online.version ?? null,
      });
      if (base) {
        await this.startSessionsWatcherIfNeeded(base);
      } else {
        void appendAiTasksLog(this, { type: "sessions.watch.skip.no_runtime_cmd" });
      }
      new Notice(this.t("notice.runtime.already_online"));
      return;
    }

    if (this.runtimeProcess && this.runtimeProcess.exitCode === null) {
      void appendAiTasksLog(this, {
        type: "runtime.start.skip.running",
        runtime_url: this.settings.runtimeUrl,
        pid: this.runtimePid ?? null,
      });
      if (base) {
        await this.startSessionsWatcherIfNeeded(base);
      } else {
        void appendAiTasksLog(this, { type: "sessions.watch.skip.no_runtime_cmd" });
      }
      new Notice(this.t("notice.runtime.already_running"));
      return;
    }

    if (!base) {
      new Notice(this.t("notice.runtime.command_empty"));
      return;
    }

    const args = splitArgs(this.settings.runtimeArgs || "");
    const urlInfo = base.urlInfo;

    // Keep runtimeUrl and spawned runtime's host/port in sync by default.
    if (args.length > 0 && args[0] === "serve" && urlInfo) {
      if (!hasCliFlag(args, "--host")) {
        args.push("--host", urlInfo.host);
      }
      if (!hasCliFlag(args, "--port")) {
        args.push("--port", String(urlInfo.port));
      }
    }
    const agentDir = base.env.AI_TASKS_AGENT_DIR ?? null;
    const codexBin = base.env.AI_TASKS_CODEX_BIN ?? null;

    void appendAiTasksLog(this, {
      type: "runtime.start.request",
      runtime_url: this.settings.runtimeUrl,
      cmd: base.cmd,
      args,
      cwd: base.cwd ?? null,
      bundled_cmd: base.bundledCmd ?? null,
      used_bundled_cmd: base.bundledCmd ? base.cmd === base.bundledCmd : null,
      host: urlInfo?.host ?? null,
      port: urlInfo?.port ?? null,
      agent_dir: agentDir ?? null,
      codex_bin: codexBin ?? null,
    });

    try {
      const child = spawn(base.cmd, args, {
        cwd: base.cwd,
        windowsHide: true,
        shell: false,
        env: base.env,
      });
      this.runtimeProcess = child;
      this.runtimePid = child.pid ?? null;

      const logDir = this.getPluginDir();
      let stdoutPath: string | null = null;
      let stderrPath: string | null = null;
      if (logDir) {
        try {
          mkdirSync(logDir, { recursive: true });
          stdoutPath = join(logDir, "runtime.stdout.log");
          stderrPath = join(logDir, "runtime.stderr.log");
          child.stdout?.on("data", (buf) => {
            if (stdoutPath) appendFileSync(stdoutPath, buf.toString());
          });
          child.stderr?.on("data", (buf) => {
            if (stderrPath) appendFileSync(stderrPath, buf.toString());
          });
          console.info(`[ai-tasks-board] runtime logs: ${stdoutPath} / ${stderrPath}`);
        } catch (e) {
          console.error("[ai-tasks-board] failed to init runtime log files", e);
          void appendAiTasksLog(this, {
            type: "runtime.start.logfiles_error",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      void appendAiTasksLog(this, {
        type: "runtime.start.spawned",
        pid: child.pid ?? null,
        stdout_log: stdoutPath,
        stderr_log: stderrPath,
      });

      child.on("exit", (code, signal) => {
        void appendAiTasksLog(this, {
          type: "runtime.process.exit",
          pid: child.pid ?? null,
          code: code ?? null,
          signal: signal ?? null,
        });
        this.runtimeProcess = null;
        this.runtimePid = null;
      });
      child.on("error", (err) => {
        void appendAiTasksLog(this, {
          type: "runtime.process.error",
          pid: child.pid ?? null,
          error: err instanceof Error ? err.message : String(err),
          // NodeJS.ErrnoException fields (best-effort).
          code: (err as unknown as { code?: string }).code ?? null,
          errno: (err as unknown as { errno?: number }).errno ?? null,
          syscall: (err as unknown as { syscall?: string }).syscall ?? null,
          path: (err as unknown as { path?: string }).path ?? null,
        });
        new Notice(this.t("notice.runtime.start_failed", { error: err.message }));
      });

      new Notice(child.pid ? this.t("notice.runtime.starting_pid", { pid: child.pid }) : this.t("notice.runtime.starting"));
      await this.startSessionsWatcherIfNeeded(base);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void appendAiTasksLog(this, {
        type: "runtime.start.exception",
        runtime_url: this.settings.runtimeUrl,
        cmd: base.cmd,
        args,
        cwd: base.cwd ?? null,
        error: msg,
      });
      new Notice(this.t("notice.runtime.start_failed", { error: msg }));
    }
  }

  async stopRuntime(): Promise<void> {
    let requested = false;

    void appendAiTasksLog(this, {
      type: "runtime.stop.request",
      runtime_url: this.settings.runtimeUrl,
      pid: this.runtimePid ?? null,
    });

    if (await this.requestRuntimeShutdown()) {
      requested = true;
    }

    if (this.runtimeProcess && this.runtimeProcess.exitCode === null) {
      this.runtimeProcess.kill();
      void appendAiTasksLog(this, { type: "runtime.stop.killed", pid: this.runtimePid ?? null });
      requested = true;
    }

    if (this.stopSessionsWatcher()) {
      requested = true;
    }

    if (requested) {
      void appendAiTasksLog(this, { type: "runtime.stop.done", ok: true });
      new Notice(this.t("notice.runtime.stop_requested"));
    } else {
      void appendAiTasksLog(this, { type: "runtime.stop.done", ok: false });
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

    const requestId = randomRequestId();
    const result: DiagnosticsResult = {
      kind: "ai",
      url,
      latency_ms: 0,
      request: req,
      ok: false,
    };

    try {
      void appendAiTasksLog(this, { type: "diagnostics.test_ai.request", request_id: requestId, runtime_url: this.settings.runtimeUrl });
      const resp = await runtimeRequestJson<unknown>(this, {
        path: "/v1/board/propose",
        method: "POST",
        body: req,
        request_id: requestId,
      });
      result.latency_ms = resp.meta.latency_ms;
      if (typeof resp.meta.http_status === "number") result.http_status = resp.meta.http_status;
      result.ok = true;
      result.response = resp.json;
      void appendAiTasksLog(this, {
        type: "diagnostics.test_ai.response",
        request_id: resp.meta.request_id,
        latency_ms: resp.meta.latency_ms,
        http_status: resp.meta.http_status,
      });
    } catch (e) {
      const err = e instanceof RuntimeHttpError ? e : null;
      if (err) {
        result.latency_ms = err.meta.latency_ms;
        if (typeof err.meta.http_status === "number") result.http_status = err.meta.http_status;
        result.error = `${err.message}${err.meta.response_snip ? " | " + err.meta.response_snip : ""}`;
        void appendAiTasksLog(this, {
          type: "diagnostics.test_ai.error",
          request_id: err.meta.request_id,
          latency_ms: err.meta.latency_ms,
          http_status: err.meta.http_status,
          response_snip: err.meta.response_snip,
          error: err.message,
        });
      } else {
        result.error = e instanceof Error ? e.message : String(e);
        void appendAiTasksLog(this, { type: "diagnostics.test_ai.error", request_id: requestId, error: result.error });
      }
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

    const requestId = randomRequestId();
    const result: DiagnosticsResult = {
      kind: "agent",
      url,
      latency_ms: 0,
      request: req,
      ok: false,
    };

    try {
      void appendAiTasksLog(this, {
        type: "diagnostics.test_agent.request",
        request_id: requestId,
        runtime_url: this.settings.runtimeUrl,
      });
      const resp = await runtimeRequestJson<unknown>(this, {
        path: "/v1/agent/ask",
        method: "POST",
        body: req,
        request_id: requestId,
        timeout_ms: 90_000,
      });
      result.latency_ms = resp.meta.latency_ms;
      if (typeof resp.meta.http_status === "number") result.http_status = resp.meta.http_status;
      result.ok = true;
      result.response = resp.json;
      void appendAiTasksLog(this, {
        type: "diagnostics.test_agent.response",
        request_id: resp.meta.request_id,
        latency_ms: resp.meta.latency_ms,
        http_status: resp.meta.http_status,
      });
    } catch (e) {
      const err = e instanceof RuntimeHttpError ? e : null;
      if (err) {
        result.latency_ms = err.meta.latency_ms;
        if (typeof err.meta.http_status === "number") result.http_status = err.meta.http_status;
        result.error = `${err.message}${err.meta.response_snip ? " | " + err.meta.response_snip : ""}`;
        void appendAiTasksLog(this, {
          type: "diagnostics.test_agent.error",
          request_id: err.meta.request_id,
          latency_ms: err.meta.latency_ms,
          http_status: err.meta.http_status,
          response_snip: err.meta.response_snip,
          error: err.message,
        });
      } else {
        result.error = e instanceof Error ? e.message : String(e);
        void appendAiTasksLog(this, { type: "diagnostics.test_agent.error", request_id: requestId, error: result.error });
      }
    }

    new AiTasksDiagnosticsModal(this, result).open();
  }

  async refreshRuntimeStatus(): Promise<{ text: string; runtimeVersion: string | null }> {
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
    const runtimeVersion = typeof status?.version === "string" ? status.version : null;
    return { text, runtimeVersion };
  }

  private async fetchRuntimeStatus(): Promise<RuntimeStatusResponse | null> {
    const url = joinUrl(this.settings.runtimeUrl, "/v1/runtime/status");
    const requestId = randomRequestId();
    try {
      const resp = await runtimeRequestJson<RuntimeStatusResponse>(this, {
        path: "/v1/runtime/status",
        method: "GET",
        request_id: requestId,
        timeout_ms: 5000,
      });
      void appendAiTasksLog(this, {
        type: "runtime.status.ok",
        request_id: resp.meta.request_id,
        latency_ms: resp.meta.latency_ms,
        http_status: resp.meta.http_status,
        pid: resp.json.pid ?? null,
        version: resp.json.version ?? null,
        uptime_s: resp.json.uptime_s ?? null,
      });
      return resp.json;
    } catch (e) {
      const err = e instanceof RuntimeHttpError ? e : null;
      void appendAiTasksLog(this, {
        type: "runtime.status.error",
        request_id: err?.meta.request_id ?? requestId,
        latency_ms: err?.meta.latency_ms ?? null,
        http_status: err?.meta.http_status ?? null,
        response_snip: err?.meta.response_snip ?? null,
        error: err ? err.message : e instanceof Error ? e.message : String(e),
        url,
      });
      return null;
    }
  }

  private async requestRuntimeShutdown(): Promise<boolean> {
    const url = joinUrl(this.settings.runtimeUrl, "/v1/runtime/shutdown");
    const requestId = randomRequestId();
    try {
      const resp = await runtimeRequestJson<{ ok?: boolean; pid?: number }>(this, {
        path: "/v1/runtime/shutdown",
        method: "POST",
        body: { force: false },
        request_id: requestId,
        timeout_ms: 5000,
      });
      void appendAiTasksLog(this, {
        type: "runtime.shutdown.ok",
        request_id: resp.meta.request_id,
        latency_ms: resp.meta.latency_ms,
        http_status: resp.meta.http_status,
        pid: resp.json.pid ?? null,
      });
      return true;
    } catch (e) {
      const err = e instanceof RuntimeHttpError ? e : null;
      void appendAiTasksLog(this, {
        type: "runtime.shutdown.error",
        request_id: err?.meta.request_id ?? requestId,
        latency_ms: err?.meta.latency_ms ?? null,
        http_status: err?.meta.http_status ?? null,
        response_snip: err?.meta.response_snip ?? null,
        error: err ? err.message : e instanceof Error ? e.message : String(e),
        url,
      });
      return false;
    }
  }
}
