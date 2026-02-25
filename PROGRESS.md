# Progress Log (AI Tasks Board)

## 2026-02-25

- Initialized project folder in `demo-lab`.
- Shipped Obsidian plugin MVP: visual board view (filter + drag/drop + status dropdown) + patch write-back + history snapshots.
- Shipped runtime MVP: `/v1/health`, `/v1/codex/exec`, and `/v1/board/propose` (best-effort Codex CLI proposal + heuristic fallback).
- Shipped selection flow MVP: editor right-click -> add/update board -> modal shows draft + before/after preview -> confirm write.
- Shipped manual archive MVP: archive Done tasks to `Archive/YYYY-MM-DD.md` (manual button) and remove from board (with history snapshot).
- Shipped sessions collector MVP (Codex): `ai-tasks-runtime sessions init/sync/watch` -> write Sessions JSON (Mode B: summary + snippets + metadata) into vault.
