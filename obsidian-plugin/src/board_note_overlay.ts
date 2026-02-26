import { MarkdownView, TFile } from "obsidian";
import type AiTasksBoardPlugin from "./main";
import { BoardPanel } from "./board_panel";

type OverlayEntry = {
  view: MarkdownView;
  file: TFile;
  host: HTMLElement;
  panel: BoardPanel;
};

export class BoardNoteOverlayManager {
  private plugin: AiTasksBoardPlugin;
  private overlays: Map<MarkdownView, OverlayEntry> = new Map();
  private refreshTimer: number | null = null;
  private isRefreshing: boolean = false;

  constructor(plugin: AiTasksBoardPlugin) {
    this.plugin = plugin;
  }

  dispose(): void {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const v of Array.from(this.overlays.keys())) this.unmount(v);
    this.overlays.clear();
  }

  requestRefresh(): void {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void this.refreshAll();
    }, 200);
  }

  async updateAll(): Promise<void> {
    const leaves = this.plugin.app.workspace.getLeavesOfType("markdown");
    const keep = new Set<MarkdownView>();

    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;

      const file = view.file;
      if (!file) {
        this.unmount(view);
        continue;
      }

      const enabled = Boolean(this.plugin.settings.renderBoardInNote);
      const isBoardNote = file.path === this.plugin.settings.boardPath;
      if (!enabled || !isBoardNote) {
        this.unmount(view);
        continue;
      }

      keep.add(view);
      await this.mount(view, file);
    }

    for (const v of Array.from(this.overlays.keys())) {
      if (!keep.has(v)) this.unmount(v);
    }
  }

  private async mount(view: MarkdownView, file: TFile): Promise<void> {
    const existing = this.overlays.get(view);
    if (existing && existing.file.path === file.path) return;
    if (existing) this.unmount(view);

    view.contentEl.classList.add("ai-tasks-board-note-overlay-active");
    const host = view.contentEl.createDiv({ cls: "ai-tasks-board-note-overlay-host" });
    const panel = new BoardPanel(this.plugin, file);
    this.overlays.set(view, { view, file, host, panel });

    try {
      await panel.render(host);
    } catch {
      // Render errors are displayed inside the panel root; avoid hard-failing the view.
    }
  }

  private unmount(view: MarkdownView): void {
    const existing = this.overlays.get(view);
    if (!existing) return;

    existing.host.remove();
    view.contentEl.classList.remove("ai-tasks-board-note-overlay-active");
    this.overlays.delete(view);
  }

  private async refreshAll(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      for (const entry of this.overlays.values()) {
        await entry.panel.render(entry.host);
      }
    } finally {
      this.isRefreshing = false;
    }
  }
}

