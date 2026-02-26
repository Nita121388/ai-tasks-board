"""
PyInstaller entrypoint for building a standalone `ai-tasks-runtime` binary.

We keep this file outside the package to avoid shipping build-only helpers to end users.
"""

from ai_tasks_runtime.cli import app


def main() -> None:
    app()


if __name__ == "__main__":
    main()

