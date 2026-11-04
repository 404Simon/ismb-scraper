"""Load scraped ISMB papers as plain full text."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from bs4 import BeautifulSoup

NOISE = (
    "script",
    "style",
    "nav",
    "header",
    "footer",
    "form",
    "div.ref-list",
    "div.fig",
    "div.table-full-width-wrap",
    "div.downloadImagesppt",
    "div.widget-ArticleDataSupplements",
    "div.widget-ArticlePubStateInfo",
    "div.article-metadata-panel",
    "div.license",
    "div.supplementary-material",
)


@dataclass(frozen=True)
class Paper:
    year: int
    paper_id: str
    title: str
    doi: str
    text: str

    @property
    def key(self) -> str:
        return f"{self.year}/{self.paper_id}"

    def as_dict(self) -> dict:
        return {"key": self.key, **asdict(self)}


def extract_text(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    root = soup.select_one("div.article-body") or soup.body or soup
    for node in root.select(",".join(NOISE)):
        node.decompose()
    return re.sub(r"\s+", " ", root.get_text(" ", strip=True)).strip()


AGGREGATE_METADATA = {"papers.json", "errors.json"}


def load_papers(source_root: Path, years: list[int]) -> list[Paper]:
    papers = []
    for year in years:
        issue_root = source_root / f"ismb-{year}"
        metadata_dir = issue_root / "metadata"
        if not metadata_dir.is_dir():
            raise FileNotFoundError(f"No scraped metadata for {year}: {metadata_dir}")

        for metadata_path in sorted(metadata_dir.glob("*.json")):
            if metadata_path.name in AGGREGATE_METADATA:
                continue

            paper_id = metadata_path.stem
            html_path = issue_root / "files" / paper_id / "article.html"
            if not html_path.is_file():
                continue

            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            text = extract_text(html_path.read_text(encoding="utf-8"))
            if len(text) < 1_000:
                continue

            papers.append(
                Paper(
                    year=year,
                    paper_id=paper_id,
                    title=metadata.get("paper_name", ""),
                    doi=metadata.get("doi", ""),
                    text=text,
                )
            )
    return papers


def load_papers_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
