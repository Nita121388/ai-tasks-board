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
