"""Tests for the ISMB semantic pipeline."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from ismb_semantic.clustering import build_graph, find_partitions, parse_cluster_spec
from ismb_semantic.embedding import validate_embedding_meta
from ismb_semantic.labeling import (
    build_fingerprint,
    build_prompt,
    label_one,
    parse_label_text,
    parse_opencode_output,
    run_labeling,
)
from ismb_semantic.papers import load_papers_jsonl

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_INPUT = REPO_ROOT / "output" / "semantic"


def _event(text: str) -> str:
    return json.dumps({"type": "text", "part": {"type": "text", "text": text}})


def _hash_papers(papers: list[dict]) -> str:
    digest = hashlib.sha256()
    for paper in papers:
        digest.update(paper["key"].encode())
        digest.update(paper["text"].encode())
    return digest.hexdigest()


def _label_input(clusters: list[dict] | None = None) -> dict:
    return {
        "k": 2,
        "clusters": clusters
        or [
            {"id": 0, "size": 2, "titles": ["Protein structure prediction", "Generative design"]},
            {"id": 1, "size": 2, "titles": ["Single-cell analysis", "Spatial omics"]},
        ],
    }


def _write_run(input_dir: Path, data: dict) -> None:
    run_dir = input_dir / "k-02"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "label_input.json").write_text(json.dumps(data), encoding="utf-8")
    (run_dir / "clusters.json").write_text(
        json.dumps({"k": 2, "actual": len(data["clusters"]), "resolution": 0.4}),
        encoding="utf-8",
    )
    rows = ["cluster,year,paper_id,title,doi"]
    for cluster in data["clusters"]:
        for index, title in enumerate(cluster["titles"]):
            rows.append(f"{cluster['id']},2024,p{cluster['id']}{index},{title},10.1/x")
    (run_dir / "clusters.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")


class ClusterSpecTest(unittest.TestCase):
    def test_range(self):
        self.assertEqual(parse_cluster_spec("2-20"), list(range(2, 21)))

    def test_list(self):
        self.assertEqual(parse_cluster_spec("4,6,8,12"), [4, 6, 8, 12])

    def test_single(self):
        self.assertEqual(parse_cluster_spec("12"), [12])

    def test_whitespace_and_duplicates(self):
        self.assertEqual(parse_cluster_spec(" 4 , 6 ,4 "), [4, 6])

    def test_invalid(self):
        for spec in ("", "abc", "1", "0-3", "5-2", "2-", "2,,3"):
            with self.subTest(spec=spec):
                with self.assertRaises(ValueError):
                    parse_cluster_spec(spec)


class LabelParsingTest(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(parse_label_text('{"label": "Protein structure"}'), "Protein structure")

    def test_fenced_json(self):
        text = 'Here is the label:\n```json\n{"label": "Single-cell omics"}\n```'
        self.assertEqual(parse_label_text(text), "Single-cell omics")

    def test_json_in_prose(self):
        self.assertEqual(
            parse_label_text('The result is {"label": "Graph learning"} as requested.'),
            "Graph learning",
        )

    def test_think_noise(self):
        self.assertEqual(
            parse_label_text('</think>\n{"label": "Graph learning"}'),
            "Graph learning",
        )

    def test_think_block_content_is_ignored(self):
        self.assertIsNone(parse_label_text('<think>{"label": "Reasoning topic"}</think>'))

    def test_label_after_think_block(self):
        text = '<think>{"label": "Reasoning topic"}</think>\n{"label": "Graph learning"}'
        self.assertEqual(parse_label_text(text), "Graph learning")

    def test_empty_and_malformed(self):
        for text in ("", "no json", '{"other": 1}', '{"label": ""}', '{"label": 4}', "{"):
            with self.subTest(text=text):
                self.assertIsNone(parse_label_text(text))

    def test_placeholders_and_bad_word_counts(self):
        for text in (
            '{"label": "..."}',
            '{"label": "…"}',
            '{"label": "TODO"}',
            '{"label": "one"}',
            '{"label": "one two three four five six seven"}',
            '{"label": "n/a"}',
        ):
            with self.subTest(text=text):
                self.assertIsNone(parse_label_text(text))

    def test_uses_last_valid_json(self):
        text = '{"label": "First topic"} then {"label": "Second topic"}'
        self.assertEqual(parse_label_text(text), "Second topic")

    def test_prompt_example_before_real_json(self):
        text = 'Reply with strict JSON only: {"label": "..."}\n{"label": "Graph learning"}'
        self.assertEqual(parse_label_text(text), "Graph learning")

    def test_multiple_json_objects_last_wins(self):
        text = '{"label": "Protein structure"} {"label": "..."} {"label": "Single-cell omics"}'
        self.assertEqual(parse_label_text(text), "Single-cell omics")

    def test_event_stream(self):
        stream = "\n".join(
            [
                json.dumps({"type": "step_start", "part": {"type": "step-start"}}),
                _event('\n{"label": '),
                _event('"Protein structure"}'),
            ]
        )
        self.assertEqual(parse_opencode_output(stream), "Protein structure")

    def test_event_stream_without_label(self):
        stream = _event("I cannot help.")
        self.assertIsNone(parse_opencode_output(stream))

    def test_non_text_events_are_ignored(self):
        stream = "\n".join(
            [
                json.dumps(
                    {
                        "type": "reasoning",
                        "part": {"type": "text", "text": '{"label": "Fake topic"}'},
                    }
                ),
                json.dumps(
                    {
                        "type": "tool",
                        "part": {"type": "text", "text": '{"label": "Tool topic"}'},
                    }
                ),
                _event('{"label": "Graph learning"}'),
            ]
        )
        self.assertEqual(parse_opencode_output(stream), "Graph learning")

    def test_event_stream_prompt_example_then_answer(self):
        stream = "\n".join(
            [
                _event('Use {"label": "..."}.'),
                _event('{"label": "Graph learning"}'),
            ]
        )
        self.assertEqual(parse_opencode_output(stream), "Graph learning")

    def test_prompt_includes_cluster(self):
        template = "id=$cluster_id size=$size\n$titles\nexisting=$existing"
        prompt = build_prompt(
            template,
            {"id": 3, "size": 12, "titles": ["Paper A", "Paper B"]},
            ["Cell biology"],
        )
        self.assertIn("id=3 size=12", prompt)
        self.assertIn("- Paper A", prompt)
        self.assertIn("existing=Cell biology", prompt)


class FingerprintTest(unittest.TestCase):
    def test_fingerprint_changes_with_inputs(self):
        clusters = _label_input()["clusters"]
        base = build_fingerprint(clusters, "model", "agent", "prompt")
        self.assertEqual(base, build_fingerprint(clusters, "model", "agent", "prompt"))
        self.assertNotEqual(base, build_fingerprint(clusters, "other", "agent", "prompt"))
        self.assertNotEqual(base, build_fingerprint(clusters, "model", "other", "prompt"))
        self.assertNotEqual(base, build_fingerprint(clusters, "model", "agent", "other"))
        changed = json.loads(json.dumps(clusters))
        changed[0]["titles"][0] = "Different title"
        self.assertNotEqual(base, build_fingerprint(changed, "model", "agent", "prompt"))

    def test_fingerprint_changes_with_agent_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp)
            agent_path = agent_dir / "agent.md"
            agent_path.write_text("steps: 2\n", encoding="utf-8")
            with patch("ismb_semantic.labeling.AGENT_DIR", agent_dir):
                before = build_fingerprint(_label_input()["clusters"], "model", "agent", "prompt")
                agent_path.write_text("steps: 3\n", encoding="utf-8")
                after = build_fingerprint(_label_input()["clusters"], "model", "agent", "prompt")
        self.assertNotEqual(before, after)

    def test_matching_fingerprint_reuses_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            results_dir = Path(tmp) / "results"
            _write_run(input_dir, _label_input())

            with patch("ismb_semantic.labeling.subprocess.run") as run:
                run.side_effect = [
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Graph learning"}'), stderr=""),
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Single-cell omics"}'), stderr=""),
                ]
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", False, 10), 0)
                self.assertEqual(run.call_count, 2)

            with patch("ismb_semantic.labeling.subprocess.run") as run:
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", False, 10), 0)
                self.assertEqual(run.call_count, 0)

            labels = json.loads((results_dir / "labels" / "k-02.json").read_text(encoding="utf-8"))
            self.assertEqual(labels, {"0": "Graph learning", "1": "Single-cell omics"})

    def test_mismatching_fingerprint_relabels(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            results_dir = Path(tmp) / "results"
            data = _label_input()
            _write_run(input_dir, data)

            with patch("ismb_semantic.labeling.subprocess.run") as run:
                run.side_effect = [
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Graph learning"}'), stderr=""),
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Single-cell omics"}'), stderr=""),
                ]
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", False, 10), 0)

            changed = json.loads(json.dumps(data))
            changed["clusters"][0]["titles"][0] = "Changed title"
            _write_run(input_dir, changed)
            with patch("ismb_semantic.labeling.subprocess.run") as run:
                run.side_effect = [
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Protein design"}'), stderr=""),
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Spatial omics"}'), stderr=""),
                ]
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", False, 10), 0)
                self.assertEqual(run.call_count, 2)

            labels = json.loads((results_dir / "labels" / "k-02.json").read_text(encoding="utf-8"))
            self.assertEqual(labels, {"0": "Protein design", "1": "Spatial omics"})

    def test_force_relabels(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            results_dir = Path(tmp) / "results"
            _write_run(input_dir, _label_input())

            with patch("ismb_semantic.labeling.subprocess.run") as run:
                run.side_effect = [
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Graph learning"}'), stderr=""),
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Single-cell omics"}'), stderr=""),
                ]
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", False, 10), 0)

            with patch("ismb_semantic.labeling.subprocess.run") as run:
                run.side_effect = [
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Protein design"}'), stderr=""),
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Spatial omics"}'), stderr=""),
                ]
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", True, 10), 0)
                self.assertEqual(run.call_count, 2)

            labels = json.loads((results_dir / "labels" / "k-02.json").read_text(encoding="utf-8"))
            self.assertEqual(labels, {"0": "Protein design", "1": "Spatial omics"})


class LabelingRunTest(unittest.TestCase):
    def test_exactly_one_call_per_cluster_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            results_dir = Path(tmp) / "results"
            _write_run(input_dir, _label_input())

            with patch("ismb_semantic.labeling.subprocess.run") as run:
                run.side_effect = [
                    SimpleNamespace(returncode=1, stdout="", stderr="boom"),
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Single-cell omics"}'), stderr=""),
                ]
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", False, 10), 1)
                self.assertEqual(run.call_count, 2)

            labels = json.loads((results_dir / "labels" / "k-02.json").read_text(encoding="utf-8"))
            self.assertEqual(labels, {"1": "Single-cell omics"})

    def test_label_one_makes_one_call(self):
        with patch("ismb_semantic.labeling.request_label") as request:
            request.return_value = None
            self.assertEqual(label_one("prompt", "m", "a", 10), (None, "malformed label output"))
            self.assertEqual(request.call_count, 1)

    def test_duplicate_label_is_a_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            results_dir = Path(tmp) / "results"
            _write_run(input_dir, _label_input())

            with patch("ismb_semantic.labeling.subprocess.run") as run:
                run.side_effect = [
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Graph learning"}'), stderr=""),
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "Graph learning"}'), stderr=""),
                ]
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", False, 10), 1)
                self.assertEqual(run.call_count, 2)

            labels = json.loads((results_dir / "labels" / "k-02.json").read_text(encoding="utf-8"))
            self.assertEqual(labels, {"0": "Graph learning"})
            self.assertFalse((results_dir / "categories" / "k-02.csv").exists())

    def test_invalid_label_is_not_saved(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            results_dir = Path(tmp) / "results"
            _write_run(input_dir, _label_input())

            with patch("ismb_semantic.labeling.subprocess.run") as run:
                run.side_effect = [
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "..."}'), stderr=""),
                    SimpleNamespace(returncode=0, stdout=_event('{"label": "one"}'), stderr=""),
                ]
                self.assertEqual(run_labeling(input_dir, results_dir, [2], "m", "a", False, 10), 2)
                self.assertEqual(run.call_count, 2)

            labels = json.loads((results_dir / "labels" / "k-02.json").read_text(encoding="utf-8"))
            self.assertEqual(labels, {})


class EmbeddingMetaTest(unittest.TestCase):
    def setUp(self):
        self.papers = [
            {"key": "2024/a", "text": "first paper"},
            {"key": "2024/b", "text": "second paper"},
        ]
        self.meta = {"ids": ["2024/a", "2024/b"], "corpus_hash": _hash_papers(self.papers)}

    def test_matching_meta(self):
        validate_embedding_meta(self.meta, self.papers)

    def test_id_mismatch(self):
        meta = {"ids": ["2024/b", "2024/a"], "corpus_hash": self.meta["corpus_hash"]}
        with self.assertRaisesRegex(ValueError, "ids do not match"):
            validate_embedding_meta(meta, self.papers)

    def test_missing_ids(self):
        with self.assertRaisesRegex(ValueError, "ids do not match"):
            validate_embedding_meta({"corpus_hash": self.meta["corpus_hash"]}, self.papers)

    def test_missing_corpus_hash(self):
        with self.assertRaisesRegex(ValueError, "missing corpus_hash"):
            validate_embedding_meta({"ids": self.meta["ids"]}, self.papers)

    def test_corpus_hash_mismatch(self):
        meta = {"ids": self.meta["ids"], "corpus_hash": "0" * 64}
        with self.assertRaisesRegex(ValueError, "corpus_hash does not match"):
            validate_embedding_meta(meta, self.papers)


class ClusterCountTest(unittest.TestCase):
    def test_more_clusters_than_papers(self):
        graph = build_graph(np.eye(3, dtype=np.float32), 2)
        with self.assertRaisesRegex(ValueError, "more clusters than papers"):
            find_partitions(graph, [4])

    def test_missing_exact_count_raises(self):
        graph = build_graph(np.eye(4, dtype=np.float32), 2)
        one_cluster = np.zeros(4, dtype=int)
        with patch("ismb_semantic.clustering._partition", return_value=one_cluster):
            with self.assertRaisesRegex(ValueError, "exact partition"):
                find_partitions(graph, [2])


class RealCorpusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        embeddings_path = REAL_INPUT / "embeddings.npy"
        papers_path = REAL_INPUT / "papers.jsonl"
        if not (embeddings_path.is_file() and papers_path.is_file()):
            raise unittest.SkipTest(f"real corpus not present under {REAL_INPUT}")
        cls.embeddings = np.load(embeddings_path)
        cls.papers = load_papers_jsonl(papers_path)
        if len(cls.embeddings) != len(cls.papers):
            raise unittest.SkipTest("real corpus embeddings and papers differ in length")

    def test_requested_cluster_counts(self):
        graph = build_graph(self.embeddings, 15)
        wanted = list(range(2, 21))
        results = find_partitions(graph, wanted)
        for k in wanted:
            with self.subTest(k=k):
                result = results[k]
                self.assertEqual(result.count, k)
                self.assertEqual(len(set(result.labels.tolist())), k)


if __name__ == "__main__":
    unittest.main()
