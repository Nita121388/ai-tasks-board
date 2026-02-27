import { App, PluginSettingTab, Setting } from "obsidian";
import AiTasksBoardPlugin from "./main";
import type { UiLanguageSetting } from "./i18n";

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

export type BoardLayout = "kanban" | "split" | "md";

export type AiTasksBoardSettings = {
  boardPath: string;
  archiveFolderPath: string;
  runtimeUrl: string;
  autoStartRuntime: boolean;
  tagPresets: string;
  boardLayout: BoardLayout;
  uiLanguage: UiLanguageSetting;
  runtimeCommand: string;
  runtimeArgs: string;
  runtimeCwd: string;
  codexCliPath: string;
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
  autoStartRuntime: true,
  tagPresets: "work\n学习\n效率\n运维\nopenclaw\nobsidian\npixel",
  boardLayout: "split",
  uiLanguage: "auto",
  runtimeCommand: "ai-tasks-runtime",
  runtimeArgs: "serve",
  runtimeCwd: "",
  codexCliPath: "",
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
      .setName(this.plugin.t("settings.ui_language.name"))
      .setDesc(this.plugin.t("settings.ui_language.desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("auto", this.plugin.t("settings.ui_language.opt.auto"));
        dropdown.addOption("zh-CN", this.plugin.t("settings.ui_language.opt.zh"));
        dropdown.addOption("en", this.plugin.t("settings.ui_language.opt.en"));
        dropdown.setValue(this.plugin.settings.uiLanguage || "auto");
        dropdown.onChange(async (value) => {
          this.plugin.settings.uiLanguage = value as UiLanguageSetting;
          await this.plugin.saveSettings();
          this.plugin.requestOverlayRefresh();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.board_path.name"))
      .setDesc(this.plugin.t("settings.board_path.desc"))
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
      .setName(this.plugin.t("settings.render_board_in_note.name"))
      .setDesc(this.plugin.t("settings.render_board_in_note.desc"))
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.renderBoardInNote)).onChange(async (value) => {
          this.plugin.settings.renderBoardInNote = value;
          await this.plugin.saveSettings();
          this.plugin.requestOverlayUpdate();
        });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.board_layout.name"))
      .setDesc(this.plugin.t("settings.board_layout.desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("split", this.plugin.t("settings.board_layout.opt.split"));
        dropdown.addOption("kanban", this.plugin.t("settings.board_layout.opt.kanban"));
        dropdown.addOption("md", this.plugin.t("settings.board_layout.opt.md"));
        dropdown.setValue(this.plugin.settings.boardLayout || "split");
        dropdown.onChange(async (value) => {
          this.plugin.settings.boardLayout = value as BoardLayout;
          await this.plugin.saveSettings();
          this.plugin.requestOverlayRefresh();
        });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.archive_folder.name"))
      .setDesc(this.plugin.t("settings.archive_folder.desc"))
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
      .setName(this.plugin.t("settings.tag_presets.name"))
      .setDesc(this.plugin.t("settings.tag_presets.desc"))
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
      .setName(this.plugin.t("settings.runtime_url.name"))
      .setDesc(this.plugin.t("settings.runtime_url.desc"))
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:17890")
          .setValue(this.plugin.settings.runtimeUrl)
          .onChange(async (value) => {
            this.plugin.settings.runtimeUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.runtime_auto_start.name"))
      .setDesc(this.plugin.t("settings.runtime_auto_start.desc"))
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.autoStartRuntime)).onChange(async (value) => {
          this.plugin.settings.autoStartRuntime = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: this.plugin.t("settings.runtime_service.heading") });

    const statusLine = containerEl.createDiv({ cls: "ai-tasks-runtime-status" });
    const statusText = statusLine.createSpan({ text: this.plugin.t("settings.runtime.status.unchecked") });
    const versionLine = containerEl.createDiv({ cls: "ai-tasks-runtime-version" });
    const versionText = versionLine.createSpan({ text: "" });
    const renderVersion = (runtimeVersion: string | null) => {
      const unknown = this.plugin.t("settings.runtime.version.unknown");
      const pluginVersion = this.plugin.getPluginVersion() || unknown;
      const runtimeVer = runtimeVersion && runtimeVersion.trim() ? runtimeVersion : unknown;
      versionText.textContent = this.plugin.t("settings.runtime.version.line", {
        plugin: pluginVersion,
        runtime: runtimeVer,
      });
    };
    const refreshStatus = async () => {
      const res = await this.plugin.refreshRuntimeStatus();
      statusText.textContent = res.text;
      renderVersion(res.runtimeVersion);
    };
    renderVersion(null);

    new Setting(containerEl)
      .setName(this.plugin.t("settings.runtime_control.name"))
      .setDesc(this.plugin.t("settings.runtime_control.desc"))
      .addButton((btn) => {
        btn.setButtonText(this.plugin.t("settings.runtime_control.btn.check")).onClick(async () => {
          await refreshStatus();
        });
      })
      .addButton((btn) => {
        btn.setButtonText(this.plugin.t("settings.runtime_control.btn.start")).onClick(async () => {
          await this.plugin.startRuntime();
          await refreshStatus();
        });
      })
      .addButton((btn) => {
        btn.setButtonText(this.plugin.t("settings.runtime_control.btn.stop")).onClick(async () => {
          await this.plugin.stopRuntime();
          await refreshStatus();
        });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.runtime_command.name"))
      .setDesc(this.plugin.t("settings.runtime_command.desc"))
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
      .setName(this.plugin.t("settings.runtime_args.name"))
      .setDesc(this.plugin.t("settings.runtime_args.desc"))
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
      .setName(this.plugin.t("settings.runtime_cwd.name"))
      .setDesc(this.plugin.t("settings.runtime_cwd.desc"))
      .addText((text) => {
        text
          .setPlaceholder("E:\\path\\to\\ai-tasks-board\\runtime")
          .setValue(this.plugin.settings.runtimeCwd)
          .onChange(async (value) => {
            this.plugin.settings.runtimeCwd = value.trim();
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: this.plugin.t("settings.model.heading") });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.model_provider.name"))
      .setDesc(this.plugin.t("settings.model_provider.desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("codex-cli", this.plugin.t("settings.model_provider.opt.codex"));
        dropdown.addOption("openai-compatible", this.plugin.t("settings.model_provider.opt.openai"));
        dropdown.setValue(this.plugin.settings.modelProvider);
        dropdown.onChange(async (value) => {
          this.plugin.settings.modelProvider = value as AiModelProvider;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.codex_cli_path.name"))
      .setDesc(this.plugin.t("settings.codex_cli_path.desc"))
      .addText((text) => {
        text
          .setPlaceholder("C:\\\\path\\\\to\\\\codex.exe")
          .setValue(this.plugin.settings.codexCliPath || "")
          .onChange(async (value) => {
            this.plugin.settings.codexCliPath = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.model_name.name"))
      .setDesc(this.plugin.t("settings.model_name.desc"))
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
      .setName(this.plugin.t("settings.model_base_url.name"))
      .setDesc(this.plugin.t("settings.model_base_url.desc"))
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
      .setName(this.plugin.t("settings.model_api_key.name"))
      .setDesc(this.plugin.t("settings.model_api_key.desc"))
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
      .setName(this.plugin.t("settings.model_temperature.name"))
      .setDesc(this.plugin.t("settings.model_temperature.desc"))
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
      .setName(this.plugin.t("settings.model_top_p.name"))
      .setDesc(this.plugin.t("settings.model_top_p.desc"))
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
      .setName(this.plugin.t("settings.model_max_tokens.name"))
      .setDesc(this.plugin.t("settings.model_max_tokens.desc"))
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

    containerEl.createEl("h3", { text: this.plugin.t("settings.diagnostics.heading") });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.diagnostics.test_ai.name"))
      .setDesc(this.plugin.t("settings.diagnostics.test_ai.desc"))
      .addButton((btn) => {
        btn.setButtonText(this.plugin.t("settings.diagnostics.test_ai.btn")).onClick(async () => {
          await this.plugin.runTestAi();
        });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("settings.diagnostics.test_agent.name"))
      .setDesc(this.plugin.t("settings.diagnostics.test_agent.desc"))
      .addButton((btn) => {
        btn.setButtonText(this.plugin.t("settings.diagnostics.test_agent.btn")).onClick(async () => {
          await this.plugin.runTestAgent();
        });
      });

    void refreshStatus();
  }
}
