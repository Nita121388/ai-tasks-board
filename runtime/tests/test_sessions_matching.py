import os
import unittest


class TestSessionsMatchingUtils(unittest.TestCase):
    def test_normalize_ai_provider(self) -> None:
        from ai_tasks_runtime.sessions.codex import _normalize_ai_provider

        self.assertEqual(_normalize_ai_provider(None), "codex-cli")
        self.assertEqual(_normalize_ai_provider(""), "codex-cli")
        self.assertEqual(_normalize_ai_provider("codex"), "codex-cli")
        self.assertEqual(_normalize_ai_provider("codex-cli"), "codex-cli")
        self.assertEqual(_normalize_ai_provider("openai"), "openai-compatible")
        self.assertEqual(_normalize_ai_provider("openai-compatible"), "openai-compatible")
        self.assertEqual(_normalize_ai_provider("auto"), "auto")

        # Unknown values should fall back to codex-cli (safe default).
        self.assertEqual(_normalize_ai_provider("something-else"), "codex-cli")

    def test_load_ai_model_config_from_env_uses_openai_api_key_fallback(self) -> None:
        from ai_tasks_runtime.sessions.codex import _load_ai_model_config_from_env

        old_openai = os.environ.get("OPENAI_API_KEY")
        old_key = os.environ.get("AI_TASKS_MODEL_API_KEY")
        try:
            if "AI_TASKS_MODEL_API_KEY" in os.environ:
                del os.environ["AI_TASKS_MODEL_API_KEY"]
            os.environ["OPENAI_API_KEY"] = "sk-test-123"

            cfg = _load_ai_model_config_from_env()
            self.assertEqual(cfg.api_key, "sk-test-123")
        finally:
            if old_openai is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = old_openai
            if old_key is None:
                os.environ.pop("AI_TASKS_MODEL_API_KEY", None)
            else:
                os.environ["AI_TASKS_MODEL_API_KEY"] = old_key

    def test_chunked(self) -> None:
        from ai_tasks_runtime.sessions.codex import _chunked

        items = [("u1", "t1", "Todo", []), ("u2", "t2", "Todo", []), ("u3", "t3", "Todo", [])]
        chunks = _chunked(items, 2)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(len(chunks[0]), 2)
        self.assertEqual(len(chunks[1]), 1)

    def test_list_task_candidates_status_priority(self) -> None:
        from ai_tasks_runtime.board_md import build_default_board_markdown, build_task_block, insert_task_block
        from ai_tasks_runtime.sessions.codex import _list_task_candidates

        board = build_default_board_markdown()
        block_doing = build_task_block(title="Doing task", status="Doing", tags=["a"])
        block_todo = build_task_block(title="Todo task", status="Todo", tags=["b"])
        block_done = build_task_block(title="Done task", status="Done", tags=["c"])

        board = insert_task_block(board, "Todo", None, block_todo)
        board = insert_task_block(board, "Done", None, block_done)
        board = insert_task_block(board, "Doing", None, block_doing)

        cands = _list_task_candidates(board)
        titles = [t[1] for t in cands]
        # Candidate ordering is status-prioritized: Doing -> Todo -> Review -> Unassigned -> Done
        self.assertEqual(titles[0], "Doing task")
        self.assertEqual(titles[1], "Todo task")
        self.assertEqual(titles[-1], "Done task")


if __name__ == "__main__":
    unittest.main()

