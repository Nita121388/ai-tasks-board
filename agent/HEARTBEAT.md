# HEARTBEAT.md

This file configures background checks for the Agent Runtime.

The runtime looks for the first JSON code block in this file.

```json
{
  "sessions": {
    "enabled": false,
    "source": "codex",
    "interval_s": 30,
    "vault_dir": "/absolute/path/to/your/vault",
    "stable_after_s": 10,
    "link_board": true,
    "board_path": "Tasks/Boards/Board.md",
    "match_mode": "ai",
    "match_threshold": 0.18,
    "ai_confidence_threshold": 0.65,
    "ai_top_k": 20
  }
}
```
