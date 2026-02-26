import { Editor, MarkdownView, Menu, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AiTasksBoardSettingTab, DEFAULT_SETTINGS, type AiModelConfig, type AiTasksBoardSettings } from "./settings";
import { AI_TASKS_VIEW_TYPE, AiTasksBoardView } from "./view";
import { AiTasksDraftModal } from "./draft_modal";

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

export default class AiTasksBoardPlugin extends Plugin {
  settings: AiTasksBoardSettings;
  private runtimeProcess: ChildProcess | null = null;
  private runtimePid: number | null = null;

  private getPluginDir(): string | null {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const base = adapter?.getBasePath?.();
    if (!base) return null;
    return join(base, this.app.vault.configDir, "plugins", "ai-tasks-board");
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(AI_TASKS_VIEW_TYPE, (leaf) => new AiTasksBoardView(leaf, this));

    this.addCommand({
      id: "open-ai-tasks-board",
      name: "Open AI Tasks board",
      callback: async () => {
        await this.activateView();
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        const sel = editor.getSelection();
        if (!sel || sel.trim().length === 0) return;

        menu.addItem((item) => {
          item
            .setTitle("AI Tasks: Add to board")
            .setIcon("plus")
            .onClick(() => {
              new AiTasksDraftModal(this, { mode: "create", selection: sel, sourcePath: view.file?.path }).open();
            });
        });

        menu.addItem((item) => {
          item
            .setTitle("AI Tasks: Update board (AI)")
            .setIcon("wand-2")
            .onClick(() => {
              new AiTasksDraftModal(this, { mode: "auto", selection: sel, sourcePath: view.file?.path }).open();
            });
        });
      })
    );

    this.addSettingTab(new AiTasksBoardSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(AI_TASKS_VIEW_TYPE);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(AI_TASKS_VIEW_TYPE);
    const existingLeaf = existing[0];
    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf: WorkspaceLeaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf();
    await leaf.setViewState({ type: AI_TASKS_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
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

  async startRuntime(): Promise<void> {
    if (this.runtimeProcess && this.runtimeProcess.exitCode === null) {
      new Notice("AI Tasks: runtime already running.");
      return;
    }

    const cmd = this.settings.runtimeCommand.trim();
    if (!cmd) {
      new Notice("AI Tasks: runtime command is empty.");
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
        new Notice(`AI Tasks: runtime start failed: ${err.message}`);
      });

      new Notice(`AI Tasks: runtime starting${child.pid ? ` (pid ${child.pid})` : ""}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`AI Tasks: runtime start failed: ${msg}`);
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
      new Notice("AI Tasks: runtime stop requested.");
    } else {
      new Notice("AI Tasks: runtime not running.");
    }
  }

  async refreshRuntimeStatus(): Promise<string> {
    const status = await this.fetchRuntimeStatus();
    const online = status?.ok;
    let text = online ? "online" : "offline";
    if (online && status?.pid) {
      text += ` (pid ${status.pid})`;
    }
    if (online && typeof status?.uptime_s === "number") {
      const mins = Math.floor(status.uptime_s / 60);
      text += ` uptime ${mins}m`;
    }
    if (this.runtimeProcess && this.runtimeProcess.exitCode === null && this.runtimePid) {
      text += ` | local pid ${this.runtimePid}`;
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
