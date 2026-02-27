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

- Split out of `demo-lab` into a standalone GitHub repo: `ai-tasks-board`.
- Refactored runtime LLM calls to be more Agno-native: route Agent ask / board propose / sessions summarize+match through `agno.Agent` backed by `CodexCLIModel` (local `codex exec --json`).
- Implemented Agno tool-calling mode (option 2): `CodexCLIModel` can emit tool calls; added `BoardToolkit` tools and `/v1/board/agent/apply` + `ai-tasks-runtime board apply` to let an agent update `Board.md` via tools.
- Obsidian plugin: replaced the Board.md note content with an in-note draggable board UI (editor + reading mode) and hid raw Markdown by default (toggleable setting).
- Obsidian plugin: fixed the escaped-newline bug (literal `\\n` in Board.md) and added auto-migration + history snapshot when detected.
- Obsidian plugin: added vault-side JSONL logs for AI calls and board writes; UI shows `engine=ai|heuristic` + confidence/reasoning when available.
- Obsidian plugin: added bulk import (AI split) + tag presets to convert a messy list into multiple tagged tasks with correct titles.
- Obsidian plugin: added Settings-tab diagnostics entry points (`Test AI` + `Test Agent`) that run safe, no-write runtime calls and show copyable JSON results.
- Obsidian plugin: added i18n (zh-CN/en + Auto) and migrated main UI strings to translations.
- Obsidian plugin: added unit tests (vitest) and wired them into GitHub Actions CI.
- Formal release prep:
  - Plugin: added a default-on "auto-start runtime" setting and bundled-runtime auto-detection (prefers `bin/<platform>-<arch>/ai-tasks-runtime` when present).
  - Runtime: default agent workspace moved to `~/.ai-tasks-board/agent` (still prefers repo `agent/` in dev); added `runtime/pyinstaller_entrypoint.py` for PyInstaller builds.
  - Release workflow: build runtime binaries (linux/win/mac x64+arm64) and publish per-platform bundle zips (plugin + runtime).

## 2026-02-27

- Release workflow: fixed packaging paths for wheel + runtime binary artifacts (downloaded artifacts can be flattened at the root).
- Published GitHub Release `v0.1.6` (bundle zips per platform/arch + plugin zip + runtime wheel/sdist + checksums).
- Obsidian plugin: added Codex CLI path setting (injects `AI_TASKS_CODEX_BIN`) and settings panel now shows plugin/runtime versions.
- Runtime: added Codex CLI exec logging (bin path, resolved path, cwd, return code, stdout/stderr sizes) for easier diagnostics.
- Obsidian plugin: added task deletion (card + detail view) with history snapshots.
- Obsidian plugin: display AI session summaries/snippets in task detail when `sessions::` is present.
- Obsidian plugin: added Agent workspace directory setting to allow prompt overrides inside a vault.
- Prompting: refined `board.split` rules to default to 1-line = 1-task while allowing multi-task single lines when obvious.
- Debugging/logging: added request-id + latency logging for plugin->runtime calls, runtime start/stop events in vault JSONL logs, and runtime-side structured logs with request-id correlation; runtime status now reports the real package version.
