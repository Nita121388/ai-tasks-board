# AI Tasks Board (Exploration)

This is the exploration workspace for "AI Tasks Board":

- Obsidian plugin (cross-platform): board file + visual board view (filter, drag/drop, status dropdown), and minimal patch write-back to `Board.md`.
- Local runtime (Agno + FastAPI): AI decisions + Codex CLI provider (`codex exec --json`) + proposal/diff generation.
- Local CLI: start/manage the runtime + session collectors (Codex/Claude Code, etc.).

Repo location policy (per Nita): this lives in `demo-lab` during exploration; later it can be split into a standalone repo.

## Layout

- `runtime/`: Python runtime (FastAPI) + Agno integration + `codex-cli` model provider
- `obsidian-plugin/`: Obsidian plugin (TypeScript)

## Notes

- The canonical requirements/design docs live in the Obsidian vault:
  - `My Projects/AI Tasks/PRD.md`
  - `My Projects/AI Tasks/技术方案.md`

