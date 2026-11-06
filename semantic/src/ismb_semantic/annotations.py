"""Write topic annotations into the scraped metadata."""

from __future__ import annotations

import csv
import json
from pathlib import Path


def _set_topic(record: dict, topic: str) -> None:
    record.setdefault("metrics", {})["T"] = topic
    meta = record.setdefault("metrics_meta", {})
    missing = [name for name in meta.get("missing", []) if name != "T"]
    meta["missing"] = missing


def _write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _normalized_doi(value: object) -> str:
    return str(value or "").strip().lower()


def _load_labels(input_dir: Path, results_dir: Path, k: int) -> tuple[list[dict], dict[str, str]]:
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

    unlabeled = sorted({row["cluster"] for row in rows} - labels.keys())
    if unlabeled:
        raise SystemExit(f"Unlabeled clusters for {name}: {', '.join(unlabeled)}")
    return rows, labels


def _update_aggregates(metadata_dir: Path, topics: dict[str, str]) -> None:
    papers_path = metadata_dir / "papers.json"
    if papers_path.is_file():
        papers = json.loads(papers_path.read_text(encoding="utf-8"))
        for record in papers:
            topic = topics.get(_normalized_doi(record.get("doi")))
            if topic is not None:
                _set_topic(record, topic)
        _write_json(papers_path, papers)

    csv_path = metadata_dir / "papers.csv"
    if not csv_path.is_file():
        return
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fields = reader.fieldnames or []
    if "T" not in fields or "doi" not in fields:
        return

    changed = False
    for row in rows:
        topic = topics.get(_normalized_doi(row.get("doi")))
        if topic is not None and row["T"] != topic:
            row["T"] = topic
            changed = True
    if not changed:
        return

    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(",".join(fields) + "\n")
        writer = csv.DictWriter(
            handle, fieldnames=fields, lineterminator="\n", quoting=csv.QUOTE_ALL
        )
        writer.writerows(rows)


def write_paper_annotations(input_dir: Path, results_dir: Path, k: int) -> int:
    """Write ``T`` for one ``k`` into the metadata and return papers without ``M``."""
    input_dir = input_dir.expanduser().resolve()
    results_dir = results_dir.expanduser().resolve()
    archive_root = input_dir.parent

    rows, labels = _load_labels(input_dir, results_dir, k)
    topics: dict[str, str] = {}
    missing_methods = 0

    for row in rows:
        topic = labels[row["cluster"]]
        metadata_path = (
            archive_root / f"ismb-{row['year']}" / "metadata" / f"{row['paper_id']}.json"
        )
        if metadata_path.is_file():
            record = json.loads(metadata_path.read_text(encoding="utf-8"))
            _set_topic(record, topic)
            _write_json(metadata_path, record)
            if not isinstance(record.get("metrics", {}).get("M"), bool):
                missing_methods += 1
        doi = _normalized_doi(row.get("doi"))
        if doi:
            topics[doi] = topic

    for metadata_dir in sorted(archive_root.glob("ismb-*/metadata")):
        _update_aggregates(metadata_dir, topics)

    return missing_methods
