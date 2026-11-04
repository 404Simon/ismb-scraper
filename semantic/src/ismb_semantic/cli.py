"""Command-line entry point for the ISMB semantic pipeline."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

from .annotations import write_paper_annotations
from .clustering import (
    DEFAULT_NEIGHBORS,
    DEFAULT_SEED,
    build_graph,
    find_partitions,
    parse_cluster_spec,
    representative_indices,
)
from .embedding import cached_embeddings, embed, validate_embedding_meta, write_meta
from .labeling import LABEL_MODEL, run_labeling
from .methods import METHODS_MODEL, run_classification
from .papers import load_papers, load_papers_jsonl


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ismb-semantic", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    embed_parser = sub.add_parser("embed", help="Embed scraped papers on HPC.")
    embed_parser.add_argument("--source", type=Path, default=Path("output"))
    embed_parser.add_argument("--output", type=Path, default=Path("output/semantic"))
    embed_parser.add_argument("--years", type=int, nargs="+", default=[2024, 2025, 2026])
    embed_parser.add_argument("--model", default="zeroentropy/zembed-1-embedding")
    embed_parser.add_argument("--batch-size", type=int, default=4)
    embed_parser.add_argument("--max-length", type=int, default=16_384)
    embed_parser.add_argument("--reuse", action="store_true", help="Reuse unchanged embeddings.")

    cluster_parser = sub.add_parser("cluster", help="Cluster embeddings with Leiden.")
    cluster_parser.add_argument("--input", type=Path, default=Path("output/semantic"))
    cluster_parser.add_argument("--clusters", default="2-20")
    cluster_parser.add_argument("--neighbors", type=int, default=DEFAULT_NEIGHBORS)
    cluster_parser.add_argument("--seed", type=int, default=DEFAULT_SEED)

    label_parser = sub.add_parser("label", help="Label clusters with headless OpenCode.")
    label_parser.add_argument("--input", type=Path, default=Path("output/semantic"))
    label_parser.add_argument("--results", type=Path, default=Path("results/semantic"))
    label_parser.add_argument("--clusters", default="2-20")
    label_parser.add_argument("--agent", default="semantic-labeler")
    label_parser.add_argument(
        "--force", action="store_true", help="Relabel clusters that already have labels."
    )
    label_parser.add_argument("--timeout", type=int, default=300, help="Seconds per OpenCode call.")

    method_parser = sub.add_parser("classify", help="Classify each paper as method-focused or not.")
    method_parser.add_argument("--input", type=Path, default=Path("output/semantic"))
    method_parser.add_argument("--results", type=Path, default=Path("results/semantic"))
    method_parser.add_argument("--agent", default="semantic-classifier")
    method_parser.add_argument(
        "--force", action="store_true", help="Reclassify papers that already have M."
    )
    method_parser.add_argument("--timeout", type=int, default=300, help="Seconds per OpenCode call.")

    export_parser = sub.add_parser("export", help="Write per-paper M/T annotations.")
    export_parser.add_argument("--input", type=Path, default=Path("output/semantic"))
    export_parser.add_argument("--results", type=Path, default=Path("results/semantic"))
    export_parser.add_argument("--k", type=int, required=True, help="Cluster count used for T.")
    export_parser.add_argument(
        "--output", type=Path, default=Path("results/semantic/papers.json")
    )
    return parser


def _run_embed(args: argparse.Namespace) -> None:
    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)

    papers = load_papers(source, args.years)
    embeddings = cached_embeddings(output, papers, args.model, args.max_length) if args.reuse else None
    if embeddings is None:
        print(f"Embedding {len(papers)} papers with {args.model}")
        embeddings = embed(
            [paper.text for paper in papers],
            args.model,
            args.batch_size,
            args.max_length,
        )
        np.save(output / "embeddings.npy", embeddings)
        write_meta(output, papers, args.model, args.max_length)
    else:
        print(f"Reusing embeddings for {len(papers)} papers")

    with (output / "papers.jsonl").open("w", encoding="utf-8") as handle:
        for paper in papers:
            handle.write(json.dumps(paper.as_dict(), ensure_ascii=False) + "\n")

    print(f"Wrote {output}")


def _write_cluster_run(
    output: Path,
    k: int,
    papers: list[dict],
    embeddings: np.ndarray,
    labels: np.ndarray,
    resolution: float,
    neighbors: int,
    seed: int,
) -> dict:
    run_dir = output / f"k-{k:02d}"
    run_dir.mkdir(parents=True, exist_ok=True)

    cluster_ids = sorted(set(labels.tolist()))
    sizes = {str(cluster_id): int((labels == cluster_id).sum()) for cluster_id in cluster_ids}

    with (run_dir / "clusters.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["cluster", "year", "paper_id", "title", "doi"])
        for paper, cluster_id in zip(papers, labels.tolist()):
            writer.writerow([cluster_id, paper["year"], paper["paper_id"], paper["title"], paper["doi"]])

    clusters = []
    for cluster_id in cluster_ids:
        indices = representative_indices(embeddings, labels, cluster_id)
        clusters.append(
            {
                "id": int(cluster_id),
                "size": len(np.where(labels == cluster_id)[0]),
                "titles": [papers[index]["title"] for index in indices.tolist()],
            }
        )

    (run_dir / "label_input.json").write_text(
        json.dumps({"k": k, "clusters": clusters}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    summary = {
        "k": k,
        "requested": k,
        "actual": len(cluster_ids),
        "resolution": resolution,
        "neighbors": neighbors,
        "seed": seed,
        "n_papers": len(papers),
        "sizes": sizes,
    }
    (run_dir / "clusters.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return summary


def _run_cluster(args: argparse.Namespace) -> None:
    input_dir = args.input.expanduser().resolve()
    papers_path = input_dir / "papers.jsonl"
    embeddings_path = input_dir / "embeddings.npy"
    if not papers_path.is_file() or not embeddings_path.is_file():
        raise SystemExit(f"Missing {papers_path} or {embeddings_path}; run embed first.")

    papers = load_papers_jsonl(papers_path)
    embeddings = np.load(embeddings_path)
    if len(papers) != len(embeddings):
        raise SystemExit(
            f"{papers_path} has {len(papers)} papers but {embeddings_path} has {len(embeddings)} rows"
        )

    meta_path = input_dir / "embedding_meta.json"
    if not meta_path.is_file():
        raise SystemExit(f"Missing {meta_path}; run embed first.")
    try:
        validate_embedding_meta(json.loads(meta_path.read_text(encoding="utf-8")), papers)
    except ValueError as error:
        raise SystemExit(str(error)) from error

    cluster_counts = parse_cluster_spec(args.clusters)
    too_many = [k for k in cluster_counts if k > len(papers)]
    if too_many:
        raise SystemExit(f"Cannot request more clusters than papers ({len(papers)}): {too_many}")

    graph = build_graph(embeddings, args.neighbors)
    results = find_partitions(graph, cluster_counts, args.seed)
    runs = []
    for k in cluster_counts:
        result = results[k]
        runs.append(
            _write_cluster_run(
                input_dir,
                k,
                papers,
                embeddings,
                result.labels,
                result.resolution,
                args.neighbors,
                args.seed,
            )
        )
        print(f"k={k:02d} requested={k} actual={result.count} resolution={result.resolution:.6f}")

    summary = {
        "n_papers": len(papers),
        "neighbors": args.neighbors,
        "seed": args.seed,
        "requested": cluster_counts,
        "runs": runs,
    }
    (input_dir / "clusters.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Wrote {input_dir}")


def _run_label(args: argparse.Namespace) -> None:
    failures = run_labeling(
        input_dir=args.input,
        results_dir=args.results,
        cluster_counts=parse_cluster_spec(args.clusters),
        model=LABEL_MODEL,
        agent=args.agent,
        force=args.force,
        timeout=args.timeout,
    )
    if failures:
        raise SystemExit(f"{failures} cluster(s) failed; rerun to resume.")


def _run_classify(args: argparse.Namespace) -> None:
    failures = run_classification(
        input_dir=args.input,
        results_dir=args.results,
        model=METHODS_MODEL,
        agent=args.agent,
        force=args.force,
        timeout=args.timeout,
    )
    if failures:
        raise SystemExit(f"{failures} paper(s) failed; rerun to resume.")


def _run_export(args: argparse.Namespace) -> None:
    missing = write_paper_annotations(
        input_dir=args.input,
        results_dir=args.results,
        output_path=args.output,
        k=args.k,
    )
    if missing:
        print(
            f"warning: {missing} paper(s) have no M; run classify first",
            file=sys.stderr,
        )


def main(argv: list[str] | None = None) -> None:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "embed":
            _run_embed(args)
        elif args.command == "cluster":
            _run_cluster(args)
        elif args.command == "label":
            _run_label(args)
        elif args.command == "classify":
            _run_classify(args)
        else:
            _run_export(args)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
