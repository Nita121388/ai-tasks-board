import { Plugin, WorkspaceLeaf } from "obsidian";
import { AiTasksBoardSettingTab, DEFAULT_SETTINGS, type AiTasksBoardSettings } from "./settings";
import { AI_TASKS_VIEW_TYPE, AiTasksBoardView } from "./view";

export default class AiTasksBoardPlugin extends Plugin {
  settings: AiTasksBoardSettings;

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
}
