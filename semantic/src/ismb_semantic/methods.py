"""Classify each paper's main contribution as a new method or not."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from string import Template

from .labeling import (
    LABEL_MODEL,
    PROJECT_ROOT,
    agent_hash,
    clean_text,
    parse_opencode_text,
    run_opencode,
)
from .papers import load_papers_jsonl

METHODS_MODEL = LABEL_MODEL
PROMPT_PATH = PROJECT_ROOT / "semantic" / "prompts" / "classify_method.md"
MAX_PAPER_CHARS = 6_000


def parse_method_text(text: str) -> bool | None:
    """Return the last valid ``{"M": true|false}`` value in *text*."""
    text = clean_text(text)
    decoder = json.JSONDecoder()
    values: list[bool] = []
    index = 0

    while True:
        start = text.find("{", index)
        if start < 0:
            break
        try:
            value, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            index = start + 1
            continue
        method = _method_from(value)
        if method is not None:
            values.append(method)
        index = start + end

    return values[-1] if values else None


def parse_opencode_method(stdout: str) -> bool | None:
    return parse_method_text(parse_opencode_text(stdout))


def build_prompt(template: str, paper: dict) -> str:
    return Template(template).substitute(
        title=paper.get("title", ""),
        text=paper_text(paper),
    )


def build_fingerprint(papers: list[dict], model: str, agent: str, template: str) -> dict[str, str]:
    payload = json.dumps(
        [(paper["key"], paper.get("title", ""), paper_text(paper)) for paper in papers],
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return {
        "paper_hash": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        "model": model,
        "agent": agent,
        "agent_hash": agent_hash(agent),
        "prompt_hash": hashlib.sha256(template.encode("utf-8")).hexdigest(),
    }


def load_methods(path: Path) -> dict[str, bool]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(value, dict):
        return {}
    return {str(key): method for key, method in value.items() if isinstance(method, bool)}


def save_methods(path: Path, methods: dict[str, bool]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = {key: methods[key] for key in sorted(methods)}
    path.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def classify_one(
    prompt: str, model: str, agent: str, timeout: int
) -> tuple[bool | None, str | None]:
    """Make exactly one OpenCode call; the caller decides whether to retry later."""
    try:
        method = parse_opencode_method(run_opencode(prompt, model, agent, timeout))
    except (OSError, RuntimeError, ValueError) as exception:
        return None, str(exception)
    return (method, None) if method is not None else (None, "malformed method output")


def run_classification(
    input_dir: Path,
    results_dir: Path,
    model: str,
    agent: str,
    force: bool,
    timeout: int,
) -> int:
    input_dir = input_dir.expanduser().resolve()
    results_dir = results_dir.expanduser().resolve()
    papers_path = input_dir / "papers.jsonl"
    if not papers_path.is_file():
        raise SystemExit(f"Missing {papers_path}; run embed first.")

    papers = load_papers_jsonl(papers_path)
    template = PROMPT_PATH.read_text(encoding="utf-8")
    fingerprint = build_fingerprint(papers, model, agent, template)
    methods_path = results_dir / "methods.json"
    meta_path = results_dir / "methods.meta.json"

    if force:
        methods: dict[str, bool] = {}
    elif _load_fingerprint(meta_path) == fingerprint:
        methods = load_methods(methods_path)
    else:
        methods = {}

    paper_keys = {paper["key"] for paper in papers}
    methods = {key: method for key, method in methods.items() if key in paper_keys}
    save_methods(methods_path, methods)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(fingerprint, indent=2) + "\n", encoding="utf-8")

    failures = 0
    for paper in papers:
        key = paper["key"]
        if key in methods:
            print(f"[M] {key}: {str(methods[key]).lower()} (reused)")
            continue

        prompt = build_prompt(template, paper)
        method, error = classify_one(prompt, model, agent, timeout)
        if method is None:
            failures += 1
            print(f"[M] {key}: FAILED ({error})", file=sys.stderr)
            continue

        methods[key] = method
        save_methods(methods_path, methods)
        print(f"[M] {key}: {str(method).lower()}")

    return failures


def _method_from(value) -> bool | None:
    if not isinstance(value, dict):
        return None
    method = value.get("M", value.get("m"))
    if isinstance(method, bool):
        return method
    if isinstance(method, str) and method.casefold() in {"true", "false"}:
        return method.casefold() == "true"
    return None


def _load_fingerprint(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def paper_text(paper: dict) -> str:
    return str(paper.get("text", ""))[:MAX_PAPER_CHARS]
