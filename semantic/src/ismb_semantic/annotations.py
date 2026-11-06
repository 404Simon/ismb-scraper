"""Write per-paper method and topic annotations for the archive."""

from __future__ import annotations

import csv
import json
from pathlib import Path

AGGREGATE_METADATA = {"papers.json", "errors.json"}


def load_methods(source_root: Path) -> dict[str, bool]:
    """Read ``M`` from the scraped per-paper metadata (written by ``bun run classify-m``)."""
    methods: dict[str, bool] = {}
    for metadata_path in sorted(source_root.glob("ismb-*/metadata/*.json")):
        if metadata_path.name in AGGREGATE_METADATA:
            continue
        try:
            record = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        method = record.get("metrics", {}).get("M")
        if isinstance(method, bool):
            year = metadata_path.parents[1].name.removeprefix("ismb-")
            methods[f"{year}/{metadata_path.stem}"] = method
    return methods


def write_paper_annotations(
    input_dir: Path, results_dir: Path, output_path: Path, k: int
) -> int:
    """Write ``doi -> {M, T}`` and return the number of papers without M."""
    input_dir = input_dir.expanduser().resolve()
    results_dir = results_dir.expanduser().resolve()
    output_path = output_path.expanduser().resolve()
    name = f"k-{k:02d}"

    clusters_path = input_dir / name / "clusters.csv"
    labels_path = results_dir / "labels" / f"{name}.json"
    if not clusters_path.is_file():
        raise SystemExit(f"Missing {clusters_path}; run cluster --clusters {k} first.")
    if not labels_path.is_file():
        raise SystemExit(f"Missing {labels_path}; run label --clusters {k} first.")

    labels = json.loads(labels_path.read_text(encoding="utf-8"))
    with clusters_path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    cluster_ids = {row["cluster"] for row in rows}
    unlabeled = sorted(cluster_ids - labels.keys())
    if unlabeled:
        raise SystemExit(f"Unlabeled clusters for {name}: {', '.join(unlabeled)}")

    methods = load_methods(input_dir.parent)
    annotations: dict[str, dict] = {}
    missing_methods: list[str] = []

    for row in rows:
        doi = (row.get("doi") or "").strip().lower()
        if not doi:
            continue
        key = f"{row['year']}/{row['paper_id']}"
        method = methods.get(key)
        if method is None:
            missing_methods.append(key)
        annotations[doi] = {"M": method, "T": labels[row["cluster"]]}

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(annotations, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return len(missing_methods)
