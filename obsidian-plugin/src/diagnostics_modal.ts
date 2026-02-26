import { Modal, Notice } from "obsidian";
import type AiTasksBoardPlugin from "./main";

export type DiagnosticsResult = {
  kind: "ai" | "agent";
  url: string;
  request: unknown;
  response?: unknown;
  ok: boolean;
  http_status?: number;
  latency_ms: number;
  error?: string;
};

async function copyToClipboard(text: string): Promise<void> {
  const clip = (globalThis as unknown as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })
    .navigator?.clipboard?.writeText;
  if (clip) {
    await clip(text);
    return;
  }

  // Fallback for environments without navigator.clipboard.
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "true");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
}

export class AiTasksDiagnosticsModal extends Modal {
  private plugin: AiTasksBoardPlugin;
  private result: DiagnosticsResult;

  constructor(plugin: AiTasksBoardPlugin, result: DiagnosticsResult) {
    super(plugin.app);
    this.plugin = plugin;
    this.result = result;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const titleKey = this.result.kind === "agent" ? "diagnostics.modal.title.agent" : "diagnostics.modal.title.ai";
    contentEl.createEl("h2", { text: this.plugin.t(titleKey) });

    const summary = contentEl.createDiv({ cls: "ai-tasks-diagnostics-summary" });
    summary.createSpan({
      text: this.result.ok ? this.plugin.t("diagnostics.modal.summary.ok") : this.plugin.t("diagnostics.modal.summary.fail"),
    });
    summary.createSpan({ text: " | " + this.plugin.t("diagnostics.modal.latency", { ms: this.result.latency_ms }) });
    if (typeof this.result.http_status === "number") {
      summary.createSpan({ text: ` | HTTP ${this.result.http_status}` });
    }
    summary.createDiv({ text: this.result.url, cls: "ai-tasks-diagnostics-url" });

    if (this.result.error) {
      const err = contentEl.createDiv({ cls: "ai-tasks-diagnostics-error" });
      err.createDiv({ text: String(this.result.error) });
    }

    const pre = contentEl.createEl("pre", { cls: "ai-tasks-diagnostics-json" });
    pre.textContent = JSON.stringify(this.result, null, 2);

    const btns = contentEl.createDiv({ cls: "ai-tasks-diagnostics-buttons" });
    const copyBtn = btns.createEl("button", { text: this.plugin.t("btn.copy_json") });
    const closeBtn = btns.createEl("button", { text: this.plugin.t("btn.close") });

    copyBtn.addEventListener("click", () => {
      void (async () => {
        try {
          await copyToClipboard(pre.textContent || "");
          new Notice(this.plugin.t("notice.clipboard.copied"));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          new Notice(this.plugin.t("notice.clipboard.copy_failed", { error: msg }));
        }
      })();
    });

    closeBtn.addEventListener("click", () => this.close());
  }
}

