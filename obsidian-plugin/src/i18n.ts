export type UiLanguageSetting = "auto" | "en" | "zh-CN";
export type ResolvedLanguage = "en" | "zh-CN";

export type TemplateVars = Record<string, string | number | null | undefined>;

export function resolveLanguage(
  setting: UiLanguageSetting | undefined,
  obsidianLanguage: string | undefined
): ResolvedLanguage {
  if (setting === "en") return "en";
  if (setting === "zh-CN") return "zh-CN";

  const raw = (obsidianLanguage || "").toLowerCase();
  if (raw.startsWith("zh")) return "zh-CN";
  return "en";
}

function interpolate(template: string, vars?: TemplateVars): string {
  if (!vars) return template;
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (m, key) => {
    const v = vars[key];
    if (v === null || v === undefined) return "";
    return String(v);
  });
}

const STRINGS = {
  // Commands / menus
  "cmd.open_board_note": { en: "AI Tasks: Open board note", zh: "AI Tasks：打开看板笔记" },
  "cmd.bulk_import": { en: "AI Tasks: Import tasks (AI)", zh: "AI Tasks：导入任务（AI）" },
  "menu.add_to_board": { en: "AI Tasks: Add to board", zh: "AI Tasks：添加到看板" },
  "menu.update_board_ai": { en: "AI Tasks: Update board (AI)", zh: "AI Tasks：更新看板（AI）" },
  "menu.import_selection_ai": {
    en: "AI Tasks: Import selection as tasks (AI)",
    zh: "AI Tasks：将选中文本导入为任务（AI）",
  },

  // Common buttons
  "btn.cancel": { en: "Cancel", zh: "取消" },
  "btn.close": { en: "Close", zh: "关闭" },
  "btn.save": { en: "Save", zh: "保存" },
  "btn.reload": { en: "Reload", zh: "重新加载" },
  "btn.copy_json": { en: "Copy JSON", zh: "复制 JSON" },
  "btn.edit": { en: "Edit", zh: "编辑" },
  "btn.archive": { en: "Archive", zh: "归档" },
  "btn.delete": { en: "Delete", zh: "删除" },
  "btn.import": { en: "Import", zh: "导入" },
  "btn.generate": { en: "Generate", zh: "生成" },

  // Notices / status
  "notice.runtime.already_running": { en: "AI Tasks: runtime already running.", zh: "AI Tasks：运行时已在运行。" },
  "notice.runtime.already_online": { en: "AI Tasks: runtime already online.", zh: "AI Tasks：运行时已在线。" },
  "notice.runtime.command_empty": { en: "AI Tasks: runtime command is empty.", zh: "AI Tasks：运行时启动命令为空。" },
  "notice.runtime.start_failed": { en: "AI Tasks: runtime start failed: {{error}}", zh: "AI Tasks：运行时启动失败：{{error}}" },
  "notice.runtime.starting": { en: "AI Tasks: runtime starting.", zh: "AI Tasks：正在启动运行时。" },
  "notice.runtime.starting_pid": { en: "AI Tasks: runtime starting (pid {{pid}}).", zh: "AI Tasks：正在启动运行时（pid {{pid}}）。" },
  "notice.runtime.stop_requested": { en: "AI Tasks: runtime stop requested.", zh: "AI Tasks：已请求停止运行时。" },
  "notice.runtime.not_running": { en: "AI Tasks: runtime not running.", zh: "AI Tasks：运行时未在运行。" },
  "notice.clipboard.copied": { en: "Copied to clipboard.", zh: "已复制到剪贴板。" },
  "notice.clipboard.copy_failed": { en: "Copy failed: {{error}}", zh: "复制失败：{{error}}" },

  // Settings: general
  "settings.board_path.name": { en: "Board file path", zh: "看板文件路径" },
  "settings.board_path.desc": {
    en: "Path to Board.md inside your vault (e.g. Tasks/Boards/Board.md).",
    zh: "Vault 内 Board.md 的路径（例如 Tasks/Boards/Board.md）。",
  },
  "settings.render_board_in_note.name": { en: "Render board in note", zh: "在笔记区域渲染看板" },
  "settings.render_board_in_note.desc": {
    en: "Replace Board.md with a draggable visual board in the note area (editor + preview).",
    zh: "在笔记区域（编辑 + 预览）用可拖拽可视化看板替换 Board.md。",
  },
  "settings.board_layout.name": { en: "Board layout", zh: "看板布局" },
  "settings.board_layout.desc": { en: "Default view for the in-note board UI.", zh: "笔记内看板 UI 的默认视图。" },
  "settings.board_layout.opt.split": { en: "Split (list + detail)", zh: "拆分（列表 + 详情）" },
  "settings.board_layout.opt.kanban": { en: "Kanban (columns)", zh: "看板（列）" },
  "settings.board_layout.opt.md": { en: "MD (raw editor)", zh: "MD（原始编辑）" },
  "settings.archive_folder.name": { en: "Archive folder path", zh: "归档文件夹路径" },
  "settings.archive_folder.desc": { en: "Folder for archived tasks (daily files), e.g. Archive.", zh: "归档任务的文件夹（按天写文件），例如 Archive。" },
  "settings.tag_presets.name": { en: "Tag presets", zh: "标签预设" },
  "settings.tag_presets.desc": { en: "One tag per line. AI will prefer these tags when proposing/importing tasks.", zh: "每行一个标签。AI 生成/导入任务时会优先使用这些标签。" },
  "settings.runtime_url.name": { en: "Runtime URL", zh: "运行时 URL" },
  "settings.runtime_url.desc": { en: "Local runtime base URL (Agno + FastAPI).", zh: "本地运行时基地址（Agno + FastAPI）。" },
  "settings.runtime_auto_start.name": { en: "Auto-start runtime", zh: "自动启动运行时" },
  "settings.runtime_auto_start.desc": {
    en: "Start the local runtime automatically when Obsidian starts.",
    zh: "打开 Obsidian 时自动启动本地运行时。",
  },

  "settings.ui_language.name": { en: "UI language", zh: "界面语言" },
  "settings.ui_language.desc": { en: "Auto follows Obsidian language. You can also override it.", zh: "自动跟随 Obsidian 语言；也可以手动覆盖。" },
  "settings.ui_language.opt.auto": { en: "Auto", zh: "自动" },
  "settings.ui_language.opt.zh": { en: "Chinese (Simplified)", zh: "中文" },
  "settings.ui_language.opt.en": { en: "English", zh: "English" },

  // Settings: runtime
  "settings.runtime_service.heading": { en: "Runtime Service", zh: "运行时服务" },
  "settings.runtime.status.unchecked": { en: "Status: unchecked", zh: "状态：未检查" },
  "runtime.status.online": { en: "online", zh: "在线" },
  "runtime.status.offline": { en: "offline", zh: "离线" },
  "runtime.status.uptime": { en: "uptime {{mins}}m", zh: "运行 {{mins}}m" },
  "runtime.status.local_pid": { en: "local pid {{pid}}", zh: "本地 pid {{pid}}" },
  "settings.runtime_control.name": { en: "Runtime control", zh: "运行时控制" },
  "settings.runtime_control.desc": { en: "Start/stop local ai-tasks-runtime and refresh status.", zh: "启动/停止本地 ai-tasks-runtime 并刷新状态。" },
  "settings.runtime_control.btn.check": { en: "Check status", zh: "检查状态" },
  "settings.runtime_control.btn.start": { en: "Start", zh: "启动" },
  "settings.runtime_control.btn.stop": { en: "Stop", zh: "停止" },
  "settings.runtime_command.name": { en: "Runtime start command", zh: "运行时启动命令" },
  "settings.runtime_command.desc": { en: "Executable to start the runtime (e.g. ai-tasks-runtime).", zh: "启动运行时的可执行文件（例如 ai-tasks-runtime）。" },
  "settings.runtime_args.name": { en: "Runtime args", zh: "运行时参数" },
  "settings.runtime_args.desc": { en: "Arguments for runtime start (e.g. serve).", zh: "运行时启动参数（例如 serve）。" },
  "settings.runtime_cwd.name": { en: "Runtime working directory", zh: "运行时工作目录" },
  "settings.runtime_cwd.desc": { en: "Optional working directory for the runtime process.", zh: "运行时进程的可选工作目录。" },
  "settings.agent_dir.name": { en: "Agent workspace directory", zh: "Agent 工作目录" },
  "settings.agent_dir.desc": {
    en: "Optional. Store prompts/memory here; set to a vault path to edit prompts in Obsidian.",
    zh: "可选。用于存放提示词/记忆；设置为 Vault 内路径即可在 Obsidian 中编辑提示词。",
  },
  "settings.runtime.version.line": { en: "Plugin v{{plugin}} | Runtime v{{runtime}}", zh: "插件 v{{plugin}} | 运行时 v{{runtime}}" },
  "settings.runtime.version.unknown": { en: "unknown", zh: "未知" },

  // Settings: model
  "settings.model.heading": { en: "Model Settings", zh: "模型设置" },
  "settings.model_provider.name": { en: "Model provider", zh: "模型提供者" },
  "settings.model_provider.desc": { en: "codex-cli (local) or OpenAI-compatible API.", zh: "codex-cli（本地）或 OpenAI-compatible API。" },
  "settings.model_provider.opt.codex": { en: "codex-cli (local)", zh: "codex-cli（本地）" },
  "settings.model_provider.opt.openai": { en: "OpenAI-compatible API", zh: "OpenAI-compatible API" },
  "settings.codex_cli_path.name": { en: "Codex CLI path", zh: "Codex CLI 路径" },
  "settings.codex_cli_path.desc": {
    en: "Optional path to local codex executable (used by codex-cli).",
    zh: "本地 codex 可执行文件路径（仅用于 codex-cli）。",
  },
  "settings.model_name.name": { en: "Model name", zh: "模型名称" },
  "settings.model_name.desc": { en: "Model identifier (for OpenAI-compatible providers).", zh: "模型标识（用于 OpenAI-compatible provider）。" },
  "settings.model_base_url.name": { en: "API base URL", zh: "API base URL" },
  "settings.model_base_url.desc": { en: "Base URL for OpenAI-compatible API (e.g. https://api.openai.com).", zh: "OpenAI-compatible 的 base URL（例如 https://api.openai.com）。" },
  "settings.model_api_key.name": { en: "API key", zh: "API key" },
  "settings.model_api_key.desc": { en: "API key for OpenAI-compatible providers (stored locally).", zh: "OpenAI-compatible 的 API key（仅保存在本地）。" },
  "settings.model_temperature.name": { en: "Temperature", zh: "温度" },
  "settings.model_temperature.desc": { en: "Sampling temperature (e.g. 0.2).", zh: "采样温度（例如 0.2）。" },
  "settings.model_top_p.name": { en: "Top P", zh: "Top P" },
  "settings.model_top_p.desc": { en: "Nucleus sampling (0-1).", zh: "核采样（0-1）。" },
  "settings.model_max_tokens.name": { en: "Max tokens", zh: "最大 tokens" },
  "settings.model_max_tokens.desc": { en: "Max output tokens (OpenAI-compatible).", zh: "最大输出 tokens（OpenAI-compatible）。" },

  // Settings: diagnostics
  "settings.diagnostics.heading": { en: "Diagnostics", zh: "诊断" },
  "settings.diagnostics.test_ai.name": { en: "Test AI", zh: "测试 AI" },
  "settings.diagnostics.test_ai.desc": {
    en: "Send a safe dry-run request to verify AI configuration (no writes).",
    zh: "发起一次安全的测试请求，用于验证 AI 配置与连通性（不会写入/修改任何文件）。",
  },
  "settings.diagnostics.test_ai.btn": { en: "Run", zh: "运行" },
  "settings.diagnostics.test_agent.name": { en: "Test Agent", zh: "测试 Agent" },
  "settings.diagnostics.test_agent.desc": {
    en: "Call the Agent pipeline to verify agent/tooling is working (no writes).",
    zh: "调用 Agent 管线，用于验证 agent/tooling 是否可用（不会写入/修改任何文件）。",
  },
  "settings.diagnostics.test_agent.btn": { en: "Run", zh: "运行" },

  // Diagnostics modal
  "diagnostics.modal.title.ai": { en: "AI Tasks: Test AI result", zh: "AI Tasks：测试 AI 结果" },
  "diagnostics.modal.title.agent": { en: "AI Tasks: Test Agent result", zh: "AI Tasks：测试 Agent 结果" },
  "diagnostics.modal.summary.ok": { en: "OK", zh: "成功" },
  "diagnostics.modal.summary.fail": { en: "FAILED", zh: "失败" },
  "diagnostics.modal.latency": { en: "Latency: {{ms}} ms", zh: "耗时：{{ms}} ms" },

  // Board panel / UI
  "board.title": { en: "AI Tasks Board", zh: "AI Tasks Board" },
  "board.view.kanban": { en: "Kanban", zh: "看板" },
  "board.view.split": { en: "Kan Detail", zh: "详情" },
  "board.view.md": { en: "MD", zh: "MD" },
  "board.search.placeholder": { en: "Search title/tags...", zh: "搜索标题/标签..." },
  "board.status_filter.all": { en: "All statuses", zh: "全部状态" },
  "board.tags.title": { en: "Tags", zh: "标签" },
  "board.tags.empty": { en: "(none)", zh: "（无）" },
  "board.md.saved_notice": { en: "AI Tasks: saved Board.md (history snapshot created).", zh: "AI Tasks：已保存 Board.md（已创建历史快照）。" },
  "board.md.read_failed": { en: "Failed to read Board.md.", zh: "读取 Board.md 失败。" },
  "board.md.parse_failed": { en: "Failed to parse Board.md (unknown error).", zh: "解析 Board.md 失败（未知错误）。" },
  "board.md.tip_switch_md": { en: "Tip: switch view to MD to edit/fix the file.", zh: "提示：切换到 MD 视图编辑/修复文件。" },
  "board.task.select_to_view": { en: "Select a task to view details.", zh: "选择一个任务查看详情。" },
  "board.task.no_details": { en: "(no details)", zh: "（无详情）" },
  "board.confirm.archive": { en: "Archive this task?", zh: "归档这个任务？" },
  "board.confirm.delete": { en: "Delete this task?", zh: "删除这个任务？" },
  "board.notice.archived_to": { en: "Archived task to {{path}}", zh: "已归档到 {{path}}" },
  "board.notice.deleted": { en: "Deleted task.", zh: "已删除任务。" },
  "board.notice.fixed_escaped_newlines": { en: "AI Tasks: fixed escaped newlines in Board.md.", zh: "AI Tasks：已修复 Board.md 中的转义换行。" },
  "board.btn.add": { en: "+ Add", zh: "+ 新建" },
  "board.task.sessions.title": { en: "AI Sessions", zh: "AI 会话" },
  "board.task.sessions.empty": { en: "No session info.", zh: "无会话信息。" },
  "board.task.sessions.missing": { en: "Session file not found.", zh: "未找到会话文件。" },

  // Draft modal
  "draft_modal.title.add": { en: "AI Tasks: Add to board", zh: "AI Tasks：添加到看板" },
  "draft_modal.title.update": { en: "AI Tasks: Update board", zh: "AI Tasks：更新看板" },
  "draft_modal.label.draft": { en: "Draft (editable)", zh: "Draft（可编辑）" },
  "draft_modal.label.instruction": { en: "Extra instruction (optional)", zh: "额外指令（可选）" },
  "draft_modal.placeholder.instruction": {
    en: "e.g. set status=Todo, add tag=release, update existing task if it matches...",
    zh: "例如：设置 status=Todo，添加 tag=release；如果匹配则更新已有任务……",
  },
  "draft_modal.btn.generate_preview": { en: "Generate preview", zh: "生成预览" },
  "draft_modal.btn.confirm_write": { en: "Confirm & write", zh: "确认并写入" },
  "draft_modal.label.before": { en: "Before", zh: "写入前" },
  "draft_modal.label.after": { en: "After", zh: "写入后" },
  "draft_modal.status.generating": { en: "Generating preview...", zh: "正在生成预览..." },
  "draft_modal.status.preview_ready": { en: "Preview ready.", zh: "预览已就绪。" },
  "draft_modal.status.failed": { en: "Failed: {{error}}", zh: "失败：{{error}}" },
  "draft_modal.notice.preview_failed": { en: "AI Tasks: preview failed: {{error}} (see console)", zh: "AI Tasks：预览失败：{{error}}（详见控制台）" },
  "draft_modal.notice.board_not_ready": { en: "AI Tasks: board file not ready.", zh: "AI Tasks：看板文件未就绪。" },
  "draft_modal.notice.generate_first": { en: "AI Tasks: please generate preview first.", zh: "AI Tasks：请先生成预览。" },
  "draft_modal.notice.wrote_update": { en: "AI Tasks: wrote board update (history snapshot created).", zh: "AI Tasks：已写入看板更新（已创建历史快照）。" },
  "draft_modal.notice.write_failed": { en: "AI Tasks: write failed: {{error}} (see console)", zh: "AI Tasks：写入失败：{{error}}（详见控制台）" },

  // Bulk import modal
  "bulk_modal.title": { en: "AI Tasks: Import tasks", zh: "AI Tasks：导入任务" },
  "bulk_modal.subtitle": {
    en: "Split a messy list into clear tasks, then import in one click.",
    zh: "把杂乱清单拆成清晰任务，再一键导入看板。",
  },
  "bulk_modal.session.title": { en: "Current computer session capture (Codex)", zh: "当前电脑会话抓取（Codex）" },
  "bulk_modal.session.btn_refresh": { en: "Refresh", zh: "刷新" },
  "bulk_modal.session.status_refreshed": { en: "Session info refreshed.", zh: "会话信息已刷新。" },
  "bulk_modal.session.btn_auto_on": { en: "Auto: ON", zh: "自动刷新：开" },
  "bulk_modal.session.btn_auto_off": { en: "Auto: OFF", zh: "自动刷新：关" },
  "bulk_modal.session.status_auto_on": { en: "Auto refresh enabled (every 30s).", zh: "已开启自动刷新（每 30 秒）。" },
  "bulk_modal.session.status_auto_off": { en: "Auto refresh disabled.", zh: "已关闭自动刷新。" },
  "bulk_modal.session.last_updated": { en: "Last updated: {{ts}}", zh: "最后刷新：{{ts}}" },
  "bulk_modal.session.root": { en: "Session directory", zh: "会话目录" },
  "bulk_modal.session.total": { en: "Total rollouts", zh: "累计抓取数" },
  "bulk_modal.session.today": { en: "Today rollouts", zh: "今日抓取数" },
  "bulk_modal.session.latest_id": { en: "Latest session", zh: "最新会话 ID" },
  "bulk_modal.session.latest_time": { en: "Latest time", zh: "最新时间" },
  "bulk_modal.session.none": { en: "(none)", zh: "（无）" },
  "bulk_modal.session.unavailable": {
    en: "Session directory not found. Start Codex at least once to generate local sessions.",
    zh: "未找到会话目录。请至少启动一次 Codex，以生成本地会话记录。",
  },
  "bulk_modal.label.text": { en: "Text to split into tasks (editable)", zh: "待拆分为任务的文本（可编辑）" },
  "bulk_modal.placeholder.text": { en: "Paste a task list here...", zh: "在这里粘贴任务列表..." },
  "bulk_modal.label.instruction": { en: "Extra instruction (optional)", zh: "额外指令（可选）" },
  "bulk_modal.placeholder.instruction": {
    en: "e.g. Use tags from presets; keep titles short; group by category...",
    zh: "例如：优先使用标签预设；标题尽量短；按类别分组……",
  },
  "bulk_modal.btn.import_to_board": { en: "Import to board", zh: "导入到看板" },
  "bulk_modal.meta.no_tags": { en: "no-tags", zh: "无标签" },
  "bulk_modal.empty": { en: "(no tasks yet)", zh: "（还没有任务）" },
  "bulk_modal.status.generating": { en: "Generating...", zh: "正在生成..." },
  "bulk_modal.status.ready": { en: "Ready ({{count}} tasks).", zh: "就绪（{{count}} 个任务）。" },
  "bulk_modal.status.failed": { en: "Failed: {{error}}", zh: "失败：{{error}}" },
  "bulk_modal.notice.generate_failed": { en: "AI Tasks: generate failed: {{error}}", zh: "AI Tasks：生成失败：{{error}}" },
  "bulk_modal.notice.board_not_ready": { en: "AI Tasks: board file not ready.", zh: "AI Tasks：看板文件未就绪。" },
  "bulk_modal.notice.generate_first": { en: "AI Tasks: please generate tasks first.", zh: "AI Tasks：请先生成任务。" },
  "bulk_modal.notice.imported": { en: "AI Tasks: imported {{count}} tasks (history snapshot created).", zh: "AI Tasks：已导入 {{count}} 个任务（已创建历史快照）。" },
  "bulk_modal.notice.import_failed": { en: "AI Tasks: import failed: {{error}}", zh: "AI Tasks：导入失败：{{error}}" },

  // Task edit modal
  "task_modal.title.edit": { en: "Edit task", zh: "编辑任务" },
  "task_modal.title.new": { en: "New task", zh: "新建任务" },
  "task_modal.label.title": { en: "Title", zh: "标题" },
  "task_modal.label.status": { en: "Status", zh: "状态" },
  "task_modal.label.tags": { en: "Tags (comma separated)", zh: "标签（逗号分隔）" },
  "task_modal.placeholder.tags": { en: "e.g. release, bug, v1", zh: "例如：release, bug, v1" },
  "task_modal.label.body": { en: "Body", zh: "内容" },
  "task_modal.notice.saved": { en: "AI Tasks: saved.", zh: "AI Tasks：已保存。" },
  "task_modal.notice.save_failed": { en: "AI Tasks: save failed: {{error}}", zh: "AI Tasks：保存失败：{{error}}" },
} as const;

export type I18nKey = keyof typeof STRINGS;

export function t(key: I18nKey, lang: ResolvedLanguage, vars?: TemplateVars): string {
  const entry = STRINGS[key];
  const template = lang === "zh-CN" ? entry.zh : entry.en;
  return interpolate(template, vars);
}
