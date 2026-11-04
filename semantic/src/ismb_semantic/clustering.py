"""Cosine k-nearest-neighbour graph and Leiden clustering."""

from __future__ import annotations

from dataclasses import dataclass

import igraph as ig
import leidenalg
import numpy as np

MIN_CLUSTERS = 2
DEFAULT_NEIGHBORS = 15
DEFAULT_SEED = 42
MIN_RESOLUTION = 0.05
MAX_RESOLUTION = 20.0
COARSE_STEPS = 60
REFINE_STEPS = 120
REFINE_ROUNDS = 4
DENSE_STEPS = 1_000
HIGH_STEPS = 400
DENSE_LIMIT = 5.0


@dataclass(frozen=True)
class ClusterResult:
    labels: np.ndarray
    resolution: float
    count: int


def parse_cluster_spec(spec: str) -> list[int]:
    """Parse ``2-20``, ``4,6,8,12``, or ``12`` into sorted unique cluster counts."""
    text = (spec or "").strip()
    if not text:
        raise ValueError("cluster spec is empty")

    values: list[int] = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            raise ValueError(f"invalid cluster spec: {spec!r}")
        if "-" in part:
            bounds = part.split("-")
            if len(bounds) != 2:
                raise ValueError(f"invalid cluster range: {part!r}")
            try:
                start, stop = int(bounds[0]), int(bounds[1])
            except ValueError as error:
                raise ValueError(f"invalid cluster range: {part!r}") from error
            if start > stop:
                raise ValueError(f"cluster range is reversed: {part!r}")
            values.extend(range(start, stop + 1))
        else:
            try:
                values.append(int(part))
            except ValueError as error:
                raise ValueError(f"invalid cluster count: {part!r}") from error

    if any(value < MIN_CLUSTERS for value in values):
        raise ValueError(f"cluster counts must be at least {MIN_CLUSTERS}")
    return sorted(set(values))


def build_graph(embeddings: np.ndarray, neighbors: int = DEFAULT_NEIGHBORS) -> ig.Graph:
    """Build one symmetric cosine k-NN graph from normalized embeddings."""
    n = len(embeddings)
    if n < 2:
        raise ValueError("at least two papers are required to cluster")
    if neighbors < 1:
        raise ValueError("neighbors must be positive")
    neighbors = min(neighbors, n - 1)

    similarity = embeddings @ embeddings.T
    np.fill_diagonal(similarity, -np.inf)
    nearest = np.argpartition(-similarity, neighbors - 1, axis=1)[:, :neighbors]
    rows = np.repeat(np.arange(n), neighbors)
    cols = nearest.ravel()
    weights = np.maximum(similarity[rows, cols], 0.0)

    graph = ig.Graph(
        n=n,
        edges=list(zip(rows.tolist(), cols.tolist())),
        directed=False,
    )
    graph.es["weight"] = weights.tolist()
    graph.simplify(combine_edges="max")
    return graph


def _partition(graph: ig.Graph, resolution: float, seed: int) -> np.ndarray:
    partition = leidenalg.find_partition(
        graph,
        leidenalg.RBConfigurationVertexPartition,
        weights="weight",
        resolution_parameter=resolution,
        seed=seed,
        n_iterations=-1,
    )
    return np.asarray(partition.membership, dtype=int)


def find_partitions(
    graph: ig.Graph, wanted_counts: list[int], seed: int = DEFAULT_SEED
) -> dict[int, ClusterResult]:
    """Search Leiden resolutions for partitions with the requested cluster counts.

    The graph is reused for every resolution. A coarse geometric scan is refined
    between resolutions that bracket a requested count. Counts can dip in narrow
    non-monotonic windows, so a dense scan is the fallback whenever a requested
    count is still missing. Raises if any requested count cannot be reached exactly.
    """
    if not wanted_counts:
        return {}
    if any(wanted < 1 for wanted in wanted_counts):
        raise ValueError("cluster counts must be positive")
    too_many = sorted(wanted for wanted in set(wanted_counts) if wanted > graph.vcount())
    if too_many:
        raise ValueError(f"cannot request more clusters than papers ({graph.vcount()}): {too_many}")

    evaluations: dict[float, tuple[np.ndarray, int]] = {}

    def evaluate(resolution: float) -> None:
        key = round(float(resolution), 12)
        if key in evaluations:
            return
        labels = _partition(graph, key, seed)
        evaluations[key] = (labels, len(set(labels.tolist())))

    def exact(wanted: int) -> ClusterResult | None:
        for resolution in sorted(evaluations):
            labels, count = evaluations[resolution]
            if count == wanted:
                return ClusterResult(labels, resolution, count)
        return None

    def refine(wanted: int) -> ClusterResult | None:
        for _ in range(REFINE_ROUNDS):
            resolutions = sorted(evaluations)
            brackets = []
            for low, high in zip(resolutions, resolutions[1:]):
                low_count = evaluations[low][1]
                high_count = evaluations[high][1]
                if (low_count < wanted < high_count) or (high_count < wanted < low_count):
                    distance = abs(low_count - wanted) + abs(high_count - wanted)
                    brackets.append((distance, high - low, low, high))
            if not brackets:
                return None

            _, _, low, high = min(brackets)
            for resolution in np.linspace(low, high, REFINE_STEPS + 2)[1:-1]:
                evaluate(resolution)

            found = exact(wanted)
            if found is not None:
                return found
        return None

    for resolution in np.geomspace(MIN_RESOLUTION, MAX_RESOLUTION, COARSE_STEPS):
        evaluate(resolution)

    results: dict[int, ClusterResult] = {}
    missing = []
    for wanted in sorted(set(wanted_counts)):
        found = exact(wanted) or refine(wanted)
        if found is None:
            missing.append(wanted)
        else:
            results[wanted] = found

    if missing:
        for resolution in np.linspace(MIN_RESOLUTION, DENSE_LIMIT, DENSE_STEPS):
            evaluate(resolution)

        still_missing = []
        for wanted in missing:
            found = exact(wanted) or refine(wanted)
            if found is None:
                still_missing.append(wanted)
            else:
                results[wanted] = found
        missing = still_missing

    if missing:
        for resolution in np.linspace(DENSE_LIMIT, MAX_RESOLUTION, HIGH_STEPS):
            evaluate(resolution)

        still_missing = []
        for wanted in missing:
            found = exact(wanted) or refine(wanted)
            if found is None:
                still_missing.append(wanted)
            else:
                results[wanted] = found
        missing = still_missing

    if missing:
        raise ValueError(
            "could not find an exact partition for clusters: " + ", ".join(str(wanted) for wanted in missing)
        )

    return results


def representative_indices(
    embeddings: np.ndarray, labels: np.ndarray, cluster_id: int, limit: int = 10
) -> np.ndarray:
    """Return indices closest to a normalized cluster centroid."""
    indices = np.where(labels == cluster_id)[0]
    centroid = embeddings[indices].mean(axis=0)
    norm = np.linalg.norm(centroid)
    if norm:
        centroid /= norm
    order = indices[np.argsort(-(embeddings[indices] @ centroid))]
    return order[:limit]
