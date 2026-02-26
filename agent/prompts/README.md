# Agent Prompts (Override)

This folder contains prompt templates used by the AI Tasks runtime.

Rules:
- Each prompt has a stable `prompt_key` like `board.propose.v1`.
- If a file exists here, the runtime uses it instead of the built-in default.
- Keep outputs strict (JSON-only where required).
- If you break JSON constraints, the runtime will fall back to heuristics.

Files:
- `board.agent.apply.v1.md` (board.agent.apply.v1)
- `board.propose.v1.md` (board.propose.v1)
- `board.split.v1.md` (board.split.v1)
- `sessions.codex.summarize.v1.md` (sessions.codex.summarize.v1)
- `sessions.codex.match_task.v1.md` (sessions.codex.match_task.v1)
- `agent.ask.v1.md` (agent.ask.v1)
