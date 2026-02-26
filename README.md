# AI Tasks Board (Exploration)

This is the exploration workspace for "AI Tasks Board":

- Obsidian plugin (cross-platform): board file + visual board view (filter, drag/drop, status dropdown), and minimal patch write-back to `Board.md`.
- Local runtime (Agno + FastAPI): AI decisions + Codex CLI provider (`codex exec --json`) + proposal/diff generation.
- Local CLI: start/manage the runtime + session collectors (Codex/Claude Code, etc.).

Repo location policy (per Nita): this lives in `demo-lab` during exploration; later it can be split into a standalone repo.

## Layout

- `runtime/`: Python runtime (FastAPI) + Agno integration + `codex-cli` model provider
- `obsidian-plugin/`: Obsidian plugin (TypeScript)

## Quickstart (dev)

### Runtime

```bash
cd ai-tasks-board/runtime
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

# HTTP runtime (board propose, codex exec)
ai-tasks-runtime serve

# Agentic (tool-calling) board apply: let the agent update Board.md via tools
# NOTE: This writes to the vault and snapshots history.
ai-tasks-runtime board apply /path/to/your/vault "Draft text here" --instruction "Optional extra instruction" --board-path "Tasks/Boards/Board.md"

# Sessions collector (Codex only for now; Mode B)
# - First run init once (ignores historical sessions before init)
# - Then sync/watch new sessions into `Vault/Sessions/codex/*.json`
ai-tasks-runtime sessions init /path/to/your/vault
ai-tasks-runtime sessions watch /path/to/your/vault

# Optional: auto-link each new session into Board.md
# - match_mode: ai|heuristic|hybrid (default: ai)
# - AI mode: link only when confidence >= ai_confidence_threshold; otherwise create Unassigned
ai-tasks-runtime sessions watch /path/to/your/vault --board-path "Tasks/Boards/Board.md" --match-mode ai --ai-confidence-threshold 0.65

# Disable board linking:
ai-tasks-runtime sessions watch /path/to/your/vault --no-link-board
```

### Agent workspace (OpenClaw-style files)

The repo includes an `ai-tasks-board/agent/` folder with the expected Agent files:

- `SOUL.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, etc.

You can bootstrap/validate them via:

```bash
ai-tasks-runtime agent init
ai-tasks-runtime agent ask "Reply with OK." --no-include-memory
ai-tasks-runtime agent heartbeat
```

### Obsidian plugin

```bash
cd ai-tasks-board/obsidian-plugin
npm install
npm run build
```

#### Using the board (in-note UI)

- Command: `AI Tasks: Open board note`
  - Opens (or creates) your `Board.md`.
  - When enabled, the plugin renders a draggable board UI directly in the note area (works in both editor + reading mode).
  - Underlying Markdown storage remains in `Board.md` but is hidden by default (toggle in plugin settings).
- Command: `AI Tasks: Import tasks (AI)`
  - Paste a messy task list and let AI split it into multiple tasks (titles + tags) before writing to `Board.md`.
  - Uses tag presets from plugin settings (one tag per line).
- Context menu (any note): select text -> right click
  - `AI Tasks: Add to board`
  - `AI Tasks: Update board (AI)`
  - `AI Tasks: Import selection as tasks (AI)`

#### History + AI logs (vault files)

- Board history snapshots (before each write):
  - If board path contains `/Boards/`: `Tasks/History/Boards/Board.<timestamp>.md`
  - Otherwise: next to your board file under `History/`
- AI runtime call logs (JSONL):
  - If board path contains `/Boards/`: `Tasks/History/Logs/ai-tasks.YYYY-MM-DD.jsonl`
  - Otherwise: next to your board file under `History/`

## Notes

- The canonical requirements/design docs live in the Obsidian vault:
  - `My Projects/AI Tasks/PRD.md`
  - `My Projects/AI Tasks/技术方案.md`
