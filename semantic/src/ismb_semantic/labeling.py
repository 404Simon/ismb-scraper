"""Label clusters with one headless OpenCode call per cluster."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from string import Template

LABEL_MODEL = "opencode-go/deepseek-v4.1-flash"

PROJECT_ROOT = next(
    (parent for parent in Path(__file__).resolve().parents if (parent / ".opencode").is_dir()),
    Path.cwd(),
)
PROMPT_PATH = PROJECT_ROOT / "semantic" / "prompts" / "label_cluster.md"
AGENT_DIR = PROJECT_ROOT / ".opencode" / "agents"

_FENCE = re.compile(r"```(?:json)?\s*|\s*```", re.IGNORECASE)
_THINK_BLOCK = re.compile(r"<think\b[^>]*>.*?</think\s*>", re.IGNORECASE | re.DOTALL)
_THINK_TAG = re.compile(r"</?think[^>]*>", re.IGNORECASE)
_ALPHANUMERIC = re.compile(r"[A-Za-z0-9]")
_PLACEHOLDER_LABELS = {
    "",
    "label",
    "your label",
    "short label",
    "category",
    "topic",
    "research area",
    "cluster label",
    "example label",
    "insert label",
    "todo",
    "tbd",
    "n a",
    "na",
    "none",
    "null",
}


def _clean_text(text: str) -> str:
    text = _THINK_BLOCK.sub("", text)
    return _THINK_TAG.sub("", _FENCE.sub("", text)).strip()


def _normalized(label: str) -> str:
    plain = re.sub(r"[^a-z0-9 ]+", "", label.casefold())
    return " ".join(plain.split())


def _validate(label: str) -> list[str]:
    problems = []
    words = len(label.split())
    if not 2 <= words <= 6:
        problems.append(f"expected 2-6 words, got {words}")
    if not _ALPHANUMERIC.search(label):
        problems.append("label has no letters or digits")
    if _normalized(label) in _PLACEHOLDER_LABELS:
        problems.append("label is a placeholder")
    return problems


def _valid(label: str | None) -> bool:
    return isinstance(label, str) and not _validate(label)


def parse_label_text(text: str) -> str | None:
    """Return the last valid ``{"label": "..."}`` object in *text*."""
    text = _clean_text(text)
    decoder = json.JSONDecoder()
    labels: list[str] = []
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
        label = _label_from(value)
        if label is not None:
            labels.append(label)
        index = start + end
    return labels[-1] if labels else None


def _label_from(value) -> str | None:
    if not isinstance(value, dict):
        return None
    label = value.get("label")
    if not isinstance(label, str):
        return None
    label = label.strip()
    return label if _valid(label) else None


def parse_opencode_output(stdout: str) -> str | None:
    """Read a ``--format json`` event stream and extract text from top-level text events."""
    parts: list[str] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "text":
            continue
        part = event.get("part")
        if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
            parts.append(part["text"])
    return parse_label_text("".join(parts))


def build_prompt(template: str, cluster: dict, existing: list[str]) -> str:
    titles = "\n".join(f"- {title}" for title in cluster.get("titles", [])) or "(none)"
    return Template(template).substitute(
        cluster_id=cluster["id"],
        size=cluster["size"],
        titles=titles,
        existing=", ".join(sorted(existing)) if existing else "(none)",
    )


def _agent_hash(agent: str) -> str:
    path = AGENT_DIR / f"{agent}.md"
    content = path.read_text(encoding="utf-8") if path.is_file() else ""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def build_fingerprint(clusters: list[dict], model: str, agent: str, template: str) -> dict[str, str]:
    payload = json.dumps(clusters, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return {
        "label_input_hash": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        "model": model,
        "agent": agent,
        "agent_hash": _agent_hash(agent),
        "prompt_hash": hashlib.sha256(template.encode("utf-8")).hexdigest(),
    }


def load_fingerprint(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def request_label(prompt: str, model: str, agent: str, timeout: int) -> str | None:
    result = subprocess.run(
        ["opencode", "run", "-m", model, "--agent", agent, "--format", "json", prompt],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        message = detail[-1] if detail else "no output"
        raise RuntimeError(f"opencode exited {result.returncode}: {message}")
    return parse_opencode_output(result.stdout)


def label_one(prompt: str, model: str, agent: str, timeout: int) -> tuple[str | None, str | None]:
    """Make exactly one OpenCode call; the caller decides whether to retry later."""
    try:
        label = request_label(prompt, model, agent, timeout)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exception:
        return None, str(exception)
    return (label, None) if label else (None, "malformed label output")


def load_labels(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(value, dict):
        return {}
    return {
        str(key): label.strip()
        for key, label in value.items()
        if isinstance(label, str) and _valid(label.strip())
    }


def save_labels(path: Path, labels: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = {key: labels[key] for key in sorted(labels, key=int)}
    path.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _duplicate(label: str, labels: dict[str, str]) -> str | None:
    key = label.casefold().strip()
    for cluster_id, existing in labels.items():
        if existing.casefold().strip() == key:
            return cluster_id
    return None


def _write_categories(path: Path, k: int, run_dir: Path, labels: dict[str, str]) -> None:
    rows = []
    with (run_dir / "clusters.csv").open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            category = labels.get(row["cluster"])
            if category is None:
                continue
            rows.append([k, category, row["year"], row["paper_id"], row["title"], row["doi"]])
    rows.sort(key=lambda row: (row[1].casefold(), row[2], row[4].casefold(), row[3]))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["k", "category", "year", "paper_id", "title", "doi"])
        writer.writerows(rows)


def _category_rows(results_dir: Path) -> list[list[str]]:
    rows: list[list[str]] = []
    for path in sorted((results_dir / "categories").glob("k-*.csv")):
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle)
            next(reader, None)
            rows.extend(row for row in reader if row)
    rows.sort(key=lambda row: (int(row[0]), row[1].casefold(), row[2], row[4].casefold(), row[3]))
    return rows


def _summary_rows(input_dir: Path, results_dir: Path) -> list[list]:
    rows: list[list] = []
    for run_dir in sorted(input_dir.glob("k-*")):
        try:
            k = int(run_dir.name.split("-", 1)[1])
        except ValueError:
            continue
        clusters_path = run_dir / "clusters.json"
        label_input_path = run_dir / "label_input.json"
        if not clusters_path.is_file() or not label_input_path.is_file():
            continue
        metadata = json.loads(clusters_path.read_text(encoding="utf-8"))
        clusters = json.loads(label_input_path.read_text(encoding="utf-8"))["clusters"]
        cluster_ids = [str(cluster["id"]) for cluster in clusters]
        labels = load_labels(results_dir / "labels" / f"{run_dir.name}.json")
        labeled = sum(1 for cluster_id in cluster_ids if cluster_id in labels)
        rows.append([k, k, metadata.get("actual", len(cluster_ids)), metadata.get("resolution", ""), labeled])
    rows.sort(key=lambda row: row[0])
    return rows


def write_indexes(input_dir: Path, results_dir: Path) -> None:
    """Rebuild combined files from all per-k artifacts, so partial runs never drop rows."""
    with (results_dir / "categories.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["k", "category", "year", "paper_id", "title", "doi"])
        writer.writerows(_category_rows(results_dir))

    with (results_dir / "summary.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["k", "requested", "actual", "resolution", "labeled"])
        writer.writerows(_summary_rows(input_dir, results_dir))


def run_labeling(
    input_dir: Path,
    results_dir: Path,
    cluster_counts: list[int],
    model: str,
    agent: str,
    force: bool,
    timeout: int,
) -> int:
    input_dir = input_dir.expanduser().resolve()
    results_dir = results_dir.expanduser().resolve()

    missing = [
        f"k-{k:02d}" for k in cluster_counts if not (input_dir / f"k-{k:02d}" / "label_input.json").is_file()
    ]
    if missing:
        raise SystemExit(f"Missing cluster artifacts under {input_dir}: {', '.join(missing)}")

    template = PROMPT_PATH.read_text(encoding="utf-8")
    labels_dir = results_dir / "labels"
    categories_dir = results_dir / "categories"
    failures = 0

    for k in cluster_counts:
        name = f"k-{k:02d}"
        run_dir = input_dir / name
        label_input = json.loads((run_dir / "label_input.json").read_text(encoding="utf-8"))
        clusters = label_input["clusters"]
        cluster_ids = [str(cluster["id"]) for cluster in clusters]
        fingerprint = build_fingerprint(clusters, model, agent, template)

        labels_path = labels_dir / f"{name}.json"
        meta_path = labels_dir / f"{name}.meta.json"
        categories_path = categories_dir / f"{name}.csv"

        if force:
            labels = {}
        elif load_fingerprint(meta_path) == fingerprint:
            labels = load_labels(labels_path)
        else:
            if labels_path.is_file() or meta_path.is_file():
                print(
                    f"[{name}] warning: label fingerprint changed; ignoring old labels",
                    file=sys.stderr,
                )
            labels = {}

        labels = {cluster_id: label for cluster_id, label in labels.items() if cluster_id in cluster_ids}
        save_labels(labels_path, labels)
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(fingerprint, indent=2) + "\n", encoding="utf-8")
        if force or not labels:
            categories_path.unlink(missing_ok=True)

        for cluster in clusters:
            cluster_id = str(cluster["id"])
            if cluster_id in labels:
                print(f"[{name}] cluster {cluster_id}: {labels[cluster_id]} (reused)")
                continue

            prompt = build_prompt(template, cluster, list(labels.values()))
            label, error = label_one(prompt, model, agent, timeout)
            if label is None:
                failures += 1
                print(f"[{name}] cluster {cluster_id}: FAILED ({error})", file=sys.stderr)
                continue

            problems = _validate(label)
            if problems:
                failures += 1
                print(
                    f"[{name}] cluster {cluster_id}: FAILED (invalid label {label!r}: {'; '.join(problems)})",
                    file=sys.stderr,
                )
                continue

            duplicate_of = _duplicate(label, labels)
            if duplicate_of is not None:
                failures += 1
                print(
                    f"[{name}] cluster {cluster_id}: FAILED (duplicate of cluster {duplicate_of}: {label!r})",
                    file=sys.stderr,
                )
                continue

            labels[cluster_id] = label
            save_labels(labels_path, labels)
            print(f"[{name}] cluster {cluster_id}: {label}")

        labeled = sum(1 for cluster_id in cluster_ids if cluster_id in labels)

        if labeled == len(cluster_ids):
            _write_categories(categories_path, k, run_dir, labels)
        else:
            categories_path.unlink(missing_ok=True)
            print(
                f"[{name}] warning: {labeled}/{len(cluster_ids)} clusters labeled; "
                f"not writing categories for {name}",
                file=sys.stderr,
            )

    write_indexes(input_dir, results_dir)
    return failures
