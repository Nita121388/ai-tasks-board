import { App, PluginSettingTab, Setting } from "obsidian";
import AiTasksBoardPlugin from "./main";

export type AiModelProvider = "codex-cli" | "openai-compatible";

export type AiModelConfig = {
  provider: AiModelProvider;
  model?: string;
  base_url?: string;
  api_key?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
};

export type BoardLayout = "kanban" | "split";

export type AiTasksBoardSettings = {
  boardPath: string;
  archiveFolderPath: string;
  runtimeUrl: string;
  tagPresets: string;
  boardLayout: BoardLayout;
  runtimeCommand: string;
  runtimeArgs: string;
  runtimeCwd: string;
  modelProvider: AiModelProvider;
  modelName: string;
  modelBaseUrl: string;
  modelApiKey: string;
  modelTemperature: number;
  modelMaxTokens: number;
  modelTopP: number;
  renderBoardInNote: boolean;
};

export const DEFAULT_SETTINGS: AiTasksBoardSettings = {
  boardPath: "Tasks/Boards/Board.md",
  archiveFolderPath: "Archive",
  runtimeUrl: "http://127.0.0.1:17890",
  tagPresets: "work\n学习\n效率\n运维\nopenclaw\nobsidian\npixel",
  boardLayout: "split",
  runtimeCommand: "ai-tasks-runtime",
  runtimeArgs: "serve",
  runtimeCwd: "",
  modelProvider: "codex-cli",
  modelName: "gpt-4o-mini",
  modelBaseUrl: "",
  modelApiKey: "",
  modelTemperature: 0.2,
  modelMaxTokens: 1024,
  modelTopP: 1,
  renderBoardInNote: true,
};

function parseNumber(value: string, fallback: number): number {
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

export class AiTasksBoardSettingTab extends PluginSettingTab {
  plugin: AiTasksBoardPlugin;

  constructor(app: App, plugin: AiTasksBoardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Board file path")
      .setDesc("Path to Board.md inside your vault (e.g. Tasks/Boards/Board.md).")
      .addText((text) => {
        text
          .setPlaceholder("Tasks/Boards/Board.md")
          .setValue(this.plugin.settings.boardPath)
          .onChange(async (value) => {
            this.plugin.settings.boardPath = value.trim();
            await this.plugin.saveSettings();
            this.plugin.requestOverlayUpdate();
          });
      });

    new Setting(containerEl)
      .setName("Render board in note")
      .setDesc("Replace Board.md with a draggable visual board in the note area (editor + preview).")
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.renderBoardInNote)).onChange(async (value) => {
          this.plugin.settings.renderBoardInNote = value;
          await this.plugin.saveSettings();
          this.plugin.requestOverlayUpdate();
        });
      });

    new Setting(containerEl)
      .setName("Board layout")
      .setDesc("Default layout for the in-note board UI.")
      .addDropdown((dropdown) => {
        dropdown.addOption("split", "Split (list + detail)");
        dropdown.addOption("kanban", "Kanban (columns)");
        dropdown.setValue(this.plugin.settings.boardLayout || "split");
        dropdown.onChange(async (value) => {
          this.plugin.settings.boardLayout = value as BoardLayout;
          await this.plugin.saveSettings();
          this.plugin.requestOverlayUpdate();
        });
      });

    new Setting(containerEl)
      .setName("Archive folder path")
      .setDesc("Folder for archived tasks (daily files), e.g. Archive.")
      .addText((text) => {
        text
          .setPlaceholder("Archive")
          .setValue(this.plugin.settings.archiveFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolderPath = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Tag presets")
      .setDesc("One tag per line. AI will prefer these tags when proposing/importing tasks.")
      .addTextArea((text) => {
        text
          .setPlaceholder("work\\n学习\\n效率\\nopenclaw")
          .setValue(this.plugin.settings.tagPresets || "")
          .onChange(async (value) => {
            this.plugin.settings.tagPresets = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Runtime URL")
      .setDesc("Local runtime base URL (Agno + FastAPI).")
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:17890")
          .setValue(this.plugin.settings.runtimeUrl)
          .onChange(async (value) => {
            this.plugin.settings.runtimeUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Runtime Service" });

    const statusLine = containerEl.createDiv({ cls: "ai-tasks-runtime-status" });
    const statusText = statusLine.createSpan({ text: "Status: unchecked" });
    const refreshStatus = async () => {
      statusText.textContent = await this.plugin.refreshRuntimeStatus();
    };

    new Setting(containerEl)
      .setName("Runtime control")
      .setDesc("Start/stop local ai-tasks-runtime and refresh status.")
      .addButton((btn) => {
        btn.setButtonText("Check status").onClick(async () => {
          await refreshStatus();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Start").onClick(async () => {
          await this.plugin.startRuntime();
          await refreshStatus();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Stop").onClick(async () => {
          await this.plugin.stopRuntime();
          await refreshStatus();
        });
      });

    new Setting(containerEl)
      .setName("Runtime start command")
      .setDesc("Executable to start the runtime (e.g. ai-tasks-runtime).")
      .addText((text) => {
        text
          .setPlaceholder("ai-tasks-runtime")
          .setValue(this.plugin.settings.runtimeCommand)
          .onChange(async (value) => {
            this.plugin.settings.runtimeCommand = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Runtime args")
      .setDesc("Arguments for runtime start (e.g. serve).")
      .addText((text) => {
        text
          .setPlaceholder("serve")
          .setValue(this.plugin.settings.runtimeArgs)
          .onChange(async (value) => {
            this.plugin.settings.runtimeArgs = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Runtime working directory")
      .setDesc("Optional working directory for the runtime process.")
      .addText((text) => {
        text
          .setPlaceholder("E:\\path\\to\\ai-tasks-board\\runtime")
          .setValue(this.plugin.settings.runtimeCwd)
          .onChange(async (value) => {
            this.plugin.settings.runtimeCwd = value.trim();
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Model Settings" });

    new Setting(containerEl)
      .setName("Model provider")
      .setDesc("codex-cli (local) or OpenAI-compatible API.")
      .addDropdown((dropdown) => {
        dropdown.addOption("codex-cli", "codex-cli (local)");
        dropdown.addOption("openai-compatible", "OpenAI-compatible API");
        dropdown.setValue(this.plugin.settings.modelProvider);
        dropdown.onChange(async (value) => {
          this.plugin.settings.modelProvider = value as AiModelProvider;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Model name")
      .setDesc("Model identifier (for OpenAI-compatible providers).")
      .addText((text) => {
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.modelName)
          .onChange(async (value) => {
            this.plugin.settings.modelName = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("Base URL for OpenAI-compatible API (e.g. https://api.openai.com).")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com")
          .setValue(this.plugin.settings.modelBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.modelBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("API key for OpenAI-compatible providers (stored locally).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.modelApiKey)
          .onChange(async (value) => {
            this.plugin.settings.modelApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Sampling temperature (e.g. 0.2).")
      .addText((text) => {
        text
          .setPlaceholder("0.2")
          .setValue(String(this.plugin.settings.modelTemperature))
          .onChange(async (value) => {
            this.plugin.settings.modelTemperature = parseNumber(value, this.plugin.settings.modelTemperature);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Top P")
      .setDesc("Nucleus sampling (0-1).")
      .addText((text) => {
        text
          .setPlaceholder("1")
          .setValue(String(this.plugin.settings.modelTopP))
          .onChange(async (value) => {
            const v = parseNumber(value, this.plugin.settings.modelTopP);
            this.plugin.settings.modelTopP = Math.min(1, Math.max(0, v));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Max tokens")
      .setDesc("Max output tokens (OpenAI-compatible).")
      .addText((text) => {
        text
          .setPlaceholder("1024")
          .setValue(String(this.plugin.settings.modelMaxTokens))
          .onChange(async (value) => {
            const v = Math.max(0, Math.floor(parseNumber(value, this.plugin.settings.modelMaxTokens)));
            this.plugin.settings.modelMaxTokens = v;
            await this.plugin.saveSettings();
          });
      });

    void refreshStatus();
  }
}
