import { Modal, Notice, TFile, Vault } from "obsidian";
import type AiTasksBoardPlugin from "./main";
import type { AiModelConfig } from "./settings";
import { insertTaskBlock, moveTaskBlock, normalizeEscapedNewlines, parseBoard, replaceTaskBlock } from "./board";
import { appendAiTasksLog } from "./ai_log";
import { ensureFolder, writeWithHistory } from "./board_fs";
import type { BoardStatus } from "./types";

type ProposeMode = "auto" | "create" | "update";

type TaskSummary = {
  uuid: string;
  title: string;
  status: string;
  tags: string[];
};

type BoardProposeRequest = {
  mode: ProposeMode;
  draft: string;
  instruction?: string | null;
  tasks: TaskSummary[];
  ai_model?: AiModelConfig;
  tag_presets?: string[];
};

type BoardProposeResponse = {
  action: "create" | "update";
  target_uuid?: string | null;
  title: string;
  status: string;
  tags: string[];
  body: string;
  reasoning?: string | null;
  confidence?: number | null;
  engine?: string | null;
  provider?: string | null;
  thread_id?: string | null;
  ai_fallback?: string | null;
};

const STATUSES: BoardStatus[] = ["Unassigned", "Todo", "Doing", "Review", "Done"];

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function logError(context: string, err: unknown, extra?: Record<string, unknown>): void {
  const msg = formatError(err);
  const payload = { error: err, ...(extra ?? {}) };
  console.error(`[ai-tasks-board] ${context}: ${msg}`, payload);
}

function normalizeStatus(s: string | null | undefined): BoardStatus {
  const t = (s ?? "").trim();
  if (t === "Todo") return "Todo";
  if (t === "Doing") return "Doing";
  if (t === "Review") return "Review";
  if (t === "Done") return "Done";
  return "Unassigned";
}

function randomUuid(): string {
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();

  // Fallback UUIDv4 generator (no dependencies).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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

async function getOrCreateBoardFile(plugin: AiTasksBoardPlugin): Promise<TFile> {
  const boardPath = plugin.settings.boardPath;
  const abs = plugin.app.vault.getAbstractFileByPath(boardPath);
  if (abs instanceof TFile) return abs;

  const parent = boardPath.split("/").slice(0, -1).join("/");
  if (parent) await ensureFolder(plugin.app.vault, parent);
  return await plugin.app.vault.create(boardPath, buildDefaultBoardMarkdown());
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/g, "") + path;
}

async function callRuntimePropose(
  plugin: AiTasksBoardPlugin,
  req: BoardProposeRequest
): Promise<BoardProposeResponse> {
  const url = joinUrl(plugin.settings.runtimeUrl, "/v1/board/propose");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Runtime error (${resp.status}): ${text}`);
  }
  return (await resp.json()) as BoardProposeResponse;
}

function asCalloutLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.map((l) => (l.length ? `> ${l}` : ">"));
}

function buildNewTaskBlock(opts: {
  uuid: string;
  title: string;
  status: BoardStatus;
  tags: string[];
  body: string;
  sourcePath?: string | null;
}): string {
  const created = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`<!-- AI-TASKS:TASK ${opts.uuid} BEGIN -->`);
  lines.push(`> [!todo] ${opts.title}`);
  lines.push(`> status:: ${opts.status}`);
  if (opts.tags.length > 0) lines.push(`> tags:: ${opts.tags.join(", ")}`);
  lines.push(`> created:: ${created}`);
  if (opts.sourcePath) lines.push(`> source:: [[${opts.sourcePath}]]`);
  lines.push(">");
  lines.push(...asCalloutLines(opts.body));
  lines.push(`<!-- AI-TASKS:TASK ${opts.uuid} END -->`);
  return lines.join("\n") + "\n";
}

function patchExistingTaskBlock(beforeBlock: string, opts: {
  uuid: string;
  title: string;
  status: BoardStatus;
  tags: string[];
  body: string;
  instruction?: string | null;
}): string {
  const lines = beforeBlock.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const endRe = new RegExp(`^<!--\\s*AI-TASKS:TASK\\s+${opts.uuid}\\s+END\\s*-->\\s*$`, "i");
  const endIdx = lines.findIndex((l) => endRe.test(l.trim()));
  if (endIdx === -1) throw new Error("Malformed task block (missing END marker).");

  // Update callout header title.
  const headerIdx = lines.findIndex((l) => /^>\\s*\\[![^\\]]+\\]/.test(l));
  if (headerIdx !== -1) {
    const m = lines[headerIdx]?.match(/^>\\s*(\\[![^\\]]+\\])\\s*(.*)$/);
    const callout = m?.[1] ?? "[!todo]";
    lines[headerIdx] = `> ${callout} ${opts.title}`;
  }

  // Update or insert status.
  let statusIdx = lines.findIndex((l) => /^>\\s*status::/i.test(l));
  if (statusIdx !== -1) {
    lines[statusIdx] = `> status:: ${opts.status}`;
  } else {
    const insertAt = headerIdx !== -1 ? headerIdx + 1 : 1;
    lines.splice(insertAt, 0, `> status:: ${opts.status}`);
    statusIdx = insertAt;
  }

  // Update/insert tags only when we have something to write (avoid destructive clears).
  if (opts.tags.length > 0) {
    const tagsIdx = lines.findIndex((l) => /^>\\s*tags::/i.test(l));
    if (tagsIdx !== -1) lines[tagsIdx] = `> tags:: ${opts.tags.join(", ")}`;
    else lines.splice(statusIdx + 1, 0, `> tags:: ${opts.tags.join(", ")}`);
  }

  // Append an update entry inside the callout, right before END marker.
  const ts = new Date().toISOString();
  const updateLines: string[] = [];
  updateLines.push(">");
  updateLines.push("> ---");
  updateLines.push(`> updated:: ${ts}`);
  if (opts.instruction?.trim()) updateLines.push(`> instruction:: ${opts.instruction.trim()}`);
  updateLines.push(...asCalloutLines(opts.body));

  lines.splice(endIdx, 0, ...updateLines);

  return lines.join("\n") + "\n";
}

export class AiTasksDraftModal extends Modal {
  private plugin: AiTasksBoardPlugin;
  private mode: ProposeMode;
  private sourcePath: string | null;

  private draft: string;
  private instruction: string = "";

  private boardFile: TFile | null = null;
  private boardContent: string = "";

  private proposal: BoardProposeResponse | null = null;
  private beforeBlock: string = "";
  private afterBlock: string = "";
  private nextBoardContent: string = "";

  private statusEl: HTMLElement | null = null;
  private beforeEl: HTMLTextAreaElement | null = null;
  private afterEl: HTMLTextAreaElement | null = null;

  constructor(plugin: AiTasksBoardPlugin, opts: { mode: ProposeMode; selection: string; sourcePath?: string | null }) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = opts.mode;
    this.sourcePath = opts.sourcePath ?? null;
    this.draft = opts.selection;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-tasks-draft-modal");

    contentEl.createEl("h2", { text: this.mode === "create" ? "AI Tasks: Add to board" : "AI Tasks: Update board" });

    const draftBox = contentEl.createDiv({ cls: "ai-tasks-draft-box" });
    draftBox.createDiv({ cls: "ai-tasks-draft-label", text: "Draft (editable)" });
    const draftInput = draftBox.createEl("textarea", { cls: "ai-tasks-draft-textarea" });
    draftInput.value = this.draft;
    draftInput.addEventListener("input", () => {
      this.draft = draftInput.value;
    });

    const instrBox = contentEl.createDiv({ cls: "ai-tasks-instr-box" });
    instrBox.createDiv({ cls: "ai-tasks-draft-label", text: "Extra instruction (optional)" });
    const instrInput = instrBox.createEl("textarea", { cls: "ai-tasks-draft-textarea" });
    instrInput.placeholder = "e.g. set status=Todo, add tag=release, update existing task if it matches...";
    instrInput.addEventListener("input", () => {
      this.instruction = instrInput.value;
    });

    const btnRow = contentEl.createDiv({ cls: "ai-tasks-draft-buttons" });
    const genBtn = btnRow.createEl("button", { text: "Generate preview" });
    const applyBtn = btnRow.createEl("button", { text: "Confirm & write" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });

    this.statusEl = contentEl.createDiv({ cls: "ai-tasks-draft-status", text: "" });

    const preview = contentEl.createDiv({ cls: "ai-tasks-draft-preview" });
    const beforeBox = preview.createDiv({ cls: "ai-tasks-draft-side" });
    beforeBox.createDiv({ cls: "ai-tasks-draft-label", text: "Before" });
    this.beforeEl = beforeBox.createEl("textarea", { cls: "ai-tasks-draft-preview-textarea" });
    this.beforeEl.readOnly = true;

    const afterBox = preview.createDiv({ cls: "ai-tasks-draft-side" });
    afterBox.createDiv({ cls: "ai-tasks-draft-label", text: "After" });
    this.afterEl = afterBox.createEl("textarea", { cls: "ai-tasks-draft-preview-textarea" });
    this.afterEl.readOnly = true;

    genBtn.addEventListener("click", async () => {
      await this.generate();
    });

    applyBtn.addEventListener("click", async () => {
      await this.apply();
    });

    cancelBtn.addEventListener("click", () => {
      this.close();
    });

    // Auto-generate once for a fast flow.
    void this.generate();
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private async generate(): Promise<void> {
    try {
      this.setStatus("Generating preview...");

      this.boardFile = await getOrCreateBoardFile(this.plugin);
      const raw = await this.plugin.app.vault.read(this.boardFile);
      const norm = normalizeEscapedNewlines(raw);
      if (norm.changed) {
        await writeWithHistory(this.plugin.app.vault, this.boardFile, norm.next);
      }
      this.boardContent = norm.next;

      const parsed = parseBoard(this.boardContent);
      const tasks: TaskSummary[] = Array.from(parsed.sections.values()).flatMap((s) =>
        s.tasks.map((t) => ({
          uuid: t.uuid,
          title: t.title,
          status: t.status,
          tags: t.tags,
        }))
      );

      const req: BoardProposeRequest = {
        mode: this.mode,
        draft: this.draft,
        instruction: this.instruction || null,
        tasks,
        ai_model: this.plugin.getModelConfig(),
        tag_presets: this.plugin.getTagPresets(),
      };

      await appendAiTasksLog(this.plugin, {
        type: "board.propose.request",
        mode: req.mode,
        draft_len: req.draft.length,
        instruction_len: (req.instruction ?? "").length,
        tasks_count: req.tasks.length,
        tag_presets_count: req.tag_presets?.length ?? 0,
        model_provider: req.ai_model?.provider ?? null,
        runtime_url: this.plugin.settings.runtimeUrl,
      });

      try {
        this.proposal = await callRuntimePropose(this.plugin, req);
        await appendAiTasksLog(this.plugin, {
          type: "board.propose.response",
          engine: this.proposal.engine ?? null,
          provider: this.proposal.provider ?? null,
          thread_id: this.proposal.thread_id ?? null,
          ai_fallback: this.proposal.ai_fallback ?? null,
          action: this.proposal.action,
          target_uuid: this.proposal.target_uuid ?? null,
          status: this.proposal.status,
          tags: this.proposal.tags,
          confidence: this.proposal.confidence ?? null,
          reasoning: this.proposal.reasoning ?? null,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await appendAiTasksLog(this.plugin, {
          type: "board.propose.error",
          error: msg,
        });
        throw e;
      }

      const action = this.proposal.action;
      const status = normalizeStatus(this.proposal.status);

      if (action === "update" && this.proposal.target_uuid) {
        const uuid = this.proposal.target_uuid;
        // Find the original block and its current physical section status.
        let beforeTask = null as null | { rawBlock: string; sectionStatus: BoardStatus };
        for (const [sectionStatus, section] of parsed.sections.entries()) {
          for (const t of section.tasks) {
            if (t.uuid === uuid) {
              beforeTask = { rawBlock: t.rawBlock, sectionStatus };
              break;
            }
          }
          if (beforeTask) break;
        }

        if (!beforeTask) {
          // Fall back to create if the task cannot be found.
          this.proposal.action = "create";
        } else {
          this.beforeBlock = beforeTask.rawBlock;
          this.afterBlock = patchExistingTaskBlock(this.beforeBlock, {
            uuid,
            title: this.proposal.title || "(Untitled)",
            status,
            tags: this.proposal.tags ?? [],
            body: this.proposal.body || this.draft,
            instruction: this.instruction || null,
          });

          let next = replaceTaskBlock(this.boardContent, uuid, this.afterBlock);
          if (beforeTask.sectionStatus !== status) {
            next = moveTaskBlock(next, uuid, status, null);
          }
          this.nextBoardContent = next;
        }
      }

      if (this.proposal.action === "create") {
        const uuid = randomUuid();
        this.beforeBlock = "";
        this.afterBlock = buildNewTaskBlock({
          uuid,
          title: this.proposal.title || "(Untitled)",
          status,
          tags: this.proposal.tags ?? [],
          body: this.proposal.body || this.draft,
          sourcePath: this.sourcePath,
        });

        // Insert at the top of the target status section (before first task if any).
        const firstUuid = parsed.sections.get(status)?.tasks?.[0]?.uuid ?? null;
        this.nextBoardContent = insertTaskBlock(this.boardContent, status, firstUuid, this.afterBlock);
      }

      if (this.beforeEl) this.beforeEl.value = this.beforeBlock;
      if (this.afterEl) this.afterEl.value = this.afterBlock;

      const meta = [];
      if (this.proposal.engine) meta.push(`engine=${this.proposal.engine}`);
      if (this.proposal.thread_id) meta.push(`thread=${this.proposal.thread_id}`);
      if (this.proposal.ai_fallback) meta.push(`ai_fallback=${this.proposal.ai_fallback}`);
      if (this.proposal.reasoning) meta.push(this.proposal.reasoning);
      if (this.proposal.confidence != null) meta.push(`confidence=${this.proposal.confidence.toFixed(2)}`);
      this.setStatus(meta.length ? meta.join(" | ") : "Preview ready.");
    } catch (e) {
      const msg = formatError(e);
      logError("生成预览失败", e, {
        boardPath: this.plugin.settings.boardPath,
        mode: this.mode,
      });
      this.setStatus(`Failed: ${msg}`);
      new Notice(`AI Tasks: 预览失败：${msg}（详见控制台）`);
    }
  }

  private async apply(): Promise<void> {
    if (!this.boardFile) {
      new Notice("AI Tasks: board file not ready.");
      return;
    }
    if (!this.nextBoardContent) {
      new Notice("AI Tasks: please generate preview first.");
      return;
    }

    try {
      await writeWithHistory(this.plugin.app.vault, this.boardFile, this.nextBoardContent);
      await appendAiTasksLog(this.plugin, {
        type: "board.write",
        via: "draft_modal",
        action: this.proposal?.action ?? null,
        target_uuid: this.proposal?.target_uuid ?? null,
      });
      new Notice("AI Tasks: wrote board update (history snapshot created).");
      this.close();
    } catch (e) {
      const msg = formatError(e);
      logError("写入看板失败", e, {
        boardPath: this.boardFile?.path ?? this.plugin.settings.boardPath,
      });
      new Notice(`AI Tasks: 写入失败：${msg}（详见控制台）`);
    }
  }
}
