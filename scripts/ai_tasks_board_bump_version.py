#!/usr/bin/env python3
"""
Bump AI Tasks Board versions across the repo.

Versions live in multiple places:
- Obsidian plugin: manifest.json + versions.json + package.json
- Runtime (Python): pyproject.toml + ai_tasks_runtime/__init__.py

Usage:
  python3 scripts/ai_tasks_board_bump_version.py 0.1.0
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


RE_SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")

ROOT = Path(__file__).resolve().parents[1]


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def _read_json(path: Path) -> dict:
    return json.loads(_read_text(path))


def _write_json(path: Path, obj: object) -> None:
    _write_text(path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def _bump_plugin(version: str) -> str:
    plugin_dir = ROOT / "obsidian-plugin"
    manifest_path = plugin_dir / "manifest.json"
    versions_path = plugin_dir / "versions.json"
    package_path = plugin_dir / "package.json"

    manifest = _read_json(manifest_path)
    min_app = str(manifest.get("minAppVersion") or "").strip() or "1.5.0"
    manifest["version"] = version
    _write_json(manifest_path, manifest)

    versions: dict = {}
    if versions_path.exists():
        versions_raw = _read_json(versions_path)
        if isinstance(versions_raw, dict):
            versions = dict(versions_raw)
    versions[version] = min_app
    _write_json(versions_path, versions)

    if package_path.exists():
        pkg = _read_json(package_path)
        if isinstance(pkg, dict):
            pkg["version"] = version
            _write_json(package_path, pkg)

    return min_app


def _replace_project_version_in_pyproject(pyproject_text: str, version: str) -> str:
    # Only replace within the [project] section to avoid touching tool configs.
    lines = pyproject_text.replace("\r\n", "\n").split("\n")
    out = []
    in_project = False
    replaced = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_project = stripped == "[project]"

        if in_project and not replaced and re.match(r'^\s*version\s*=\s*".*"\s*$', line):
            out.append(f'version = "{version}"')
            replaced = True
            continue

        out.append(line)

    if not replaced:
        raise RuntimeError("Failed to find [project] version in pyproject.toml")

    return "\n".join(out).rstrip("\n") + "\n"


def _bump_runtime(version: str) -> None:
    runtime_dir = ROOT / "runtime"
    pyproject_path = runtime_dir / "pyproject.toml"
    init_path = runtime_dir / "src" / "ai_tasks_runtime" / "__init__.py"

    pyproject = _read_text(pyproject_path)
    pyproject = _replace_project_version_in_pyproject(pyproject, version)
    _write_text(pyproject_path, pyproject)

    init_text = _read_text(init_path)
    if "__version__" not in init_text:
        raise RuntimeError(f"Missing __version__ in {init_path}")
    init_text2, n = re.subn(
        r'(?m)^__version__\s*=\s*".*"\s*$',
        f'__version__ = "{version}"',
        init_text,
        count=1,
    )
    if n != 1:
        raise RuntimeError(f"Failed to update __version__ in {init_path}")
    _write_text(init_path, init_text2)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("version", help="SemVer, e.g. 0.1.0 or 0.1.0-beta.1")
    args = ap.parse_args(argv)

    version = args.version.strip()
    if not RE_SEMVER.match(version):
        print(f"Invalid version: {version}", file=sys.stderr)
        return 2

    min_app = _bump_plugin(version)
    _bump_runtime(version)

    print(f"OK: bumped AI Tasks Board to {version} (minAppVersion={min_app})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
