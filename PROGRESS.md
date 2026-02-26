# Progress Log (AI Tasks Board)

## 2026-02-25

- Initialized project folder in `demo-lab`.
- Shipped Obsidian plugin MVP: visual board view (filter + drag/drop + status dropdown) + patch write-back + history snapshots.
- Shipped runtime MVP: `/v1/health`, `/v1/codex/exec`, and `/v1/board/propose` (best-effort Codex CLI proposal + heuristic fallback).
- Shipped Agent Runtime scaffolding: project-local `agent/` workspace (SOUL/USER/MEMORY/HEARTBEAT) + `/v1/agent/ask` + `ai-tasks-runtime agent ...` commands.
- Shipped selection flow MVP: editor right-click -> add/update board -> modal shows draft + before/after preview -> confirm write.
- Shipped manual archive MVP: archive Done tasks to `Archive/YYYY-MM-DD.md` (manual button) and remove from board (with history snapshot).
- Shipped sessions collector MVP (Codex): `ai-tasks-runtime sessions init/sync/watch` -> write Sessions JSON (Mode B: summary + snippets + metadata) into vault.
- Shipped sessions -> board auto-link MVP (Codex): on each new session, best-effort match to an existing task and append `sessions:: codex:<id>`; otherwise auto-create an `Unassigned` task (with history snapshot).

## 2026-02-26

- Refactored runtime LLM calls to be more Agno-native: route Agent ask / board propose / sessions summarize+match through `agno.Agent` backed by `CodexCLIModel` (local `codex exec --json`).
- Implemented Agno tool-calling mode (option 2): `CodexCLIModel` can emit tool calls; added `BoardToolkit` tools and `/v1/board/agent/apply` + `ai-tasks-runtime board apply` to let an agent update `Board.md` via tools.
- Obsidian plugin: replaced the Board.md note content with an in-note draggable board UI (editor + reading mode) and hid raw Markdown by default (toggleable setting).
- Obsidian plugin: fixed the escaped-newline bug (literal `\\n` in Board.md) and added auto-migration + history snapshot when detected.
- Obsidian plugin: added vault-side JSONL logs for AI calls and board writes; UI shows `engine=ai|heuristic` + confidence/reasoning when available.
- Obsidian plugin: added bulk import (AI split) + tag presets to convert a messy list into multiple tagged tasks with correct titles.
