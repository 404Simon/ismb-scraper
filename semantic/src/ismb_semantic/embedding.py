"""Embedding cache and document embedding."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from .papers import Paper


def corpus_hash(papers: list[Paper]) -> str:
    return _hash_pairs((paper.key, paper.text) for paper in papers)


def _hash_pairs(pairs) -> str:
    digest = hashlib.sha256()
    for key, text in pairs:
        digest.update(key.encode())
        digest.update(text.encode())
    return digest.hexdigest()


def validate_embedding_meta(meta: dict, papers: list[dict]) -> None:
    """Fail if ``embedding_meta.json`` does not describe exactly these papers."""
    expected_ids = [paper["key"] for paper in papers]
    actual_ids = meta.get("ids")
    if actual_ids != expected_ids:
        if not isinstance(actual_ids, list):
            detail = "ids missing"
        elif len(actual_ids) != len(expected_ids):
            detail = f"{len(actual_ids)} ids vs {len(expected_ids)} papers"
        else:
            row = next(
                i for i, (actual, expected) in enumerate(zip(actual_ids, expected_ids)) if actual != expected
            )
            detail = f"row {row}: {actual_ids[row]!r} != {expected_ids[row]!r}"
        raise ValueError(f"embedding_meta.json ids do not match papers.jsonl ({detail}); run embed again")
    if "corpus_hash" not in meta:
        raise ValueError("embedding_meta.json is missing corpus_hash; run embed again")
    expected_hash = _hash_pairs((paper["key"], paper["text"]) for paper in papers)
    if meta["corpus_hash"] != expected_hash:
        raise ValueError("embedding_meta.json corpus_hash does not match papers.jsonl; run embed again")


def cached_embeddings(output: Path, papers: list[Paper], model: str, max_length: int) -> np.ndarray | None:
    path = output / "embeddings.npy"
    meta_path = output / "embedding_meta.json"
    if not (path.is_file() and meta_path.is_file()):
        return None

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    expected = {
        "model": model,
        "max_length": max_length,
        "ids": [paper.key for paper in papers],
        "corpus_hash": corpus_hash(papers),
    }
    if any(meta.get(key) != value for key, value in expected.items()):
        return None

    embeddings = np.load(path)
    return embeddings if len(embeddings) == len(papers) else None


def embed(texts: list[str], model: str, batch_size: int, max_length: int) -> np.ndarray:
    import torch
    from sentence_transformers import SentenceTransformer

    encoder = SentenceTransformer(
        model,
        trust_remote_code=True,
        model_kwargs={"torch_dtype": torch.bfloat16},
    )
    encoder.max_seq_length = min(max_length, encoder.max_seq_length)
    return encoder.encode_document(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=True,
    ).astype(np.float32)


def write_meta(output: Path, papers: list[Paper], model: str, max_length: int) -> None:
    meta = {
        "model": model,
        "max_length": max_length,
        "ids": [paper.key for paper in papers],
        "corpus_hash": corpus_hash(papers),
    }
    (output / "embedding_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
