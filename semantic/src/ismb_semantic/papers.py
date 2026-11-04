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


def load_papers(source_root: Path, years: list[int]) -> list[Paper]:
    papers = []
    for year in years:
        papers_dir = source_root / f"ismb-{year}" / "papers"
        if not papers_dir.is_dir():
            raise FileNotFoundError(f"No scraped papers for {year}: {papers_dir}")

        for metadata_path in sorted(papers_dir.glob("*/metadata.json")):
            html_path = metadata_path.with_name("article.html")
            if not html_path.is_file():
                continue

            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            text = extract_text(html_path.read_text(encoding="utf-8"))
            if len(text) < 1_000:
                continue

            papers.append(
                Paper(
                    year=year,
                    paper_id=metadata_path.parent.name,
                    title=metadata.get("paper_name", ""),
                    doi=metadata.get("doi", ""),
                    text=text,
                )
            )
    return papers


def load_papers_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
