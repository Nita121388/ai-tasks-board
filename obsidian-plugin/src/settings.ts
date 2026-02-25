import { App, PluginSettingTab, Setting } from "obsidian";
import AiTasksBoardPlugin from "./main";

export type AiTasksBoardSettings = {
  boardPath: string;
  runtimeUrl: string;
};

export const DEFAULT_SETTINGS: AiTasksBoardSettings = {
  boardPath: "Tasks/Boards/Board.md",
  runtimeUrl: "http://127.0.0.1:17890",
};

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
  }
}

