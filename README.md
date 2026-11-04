# ISMB scraper

Archive an Oxford Academic *Bioinformatics* proceedings issue (for example, ISMB) into a paper-centric dataset: metadata, authors, metrics, DOI, abstract, PDF, cleaned article HTML, figures, and reproducibility artifacts.

One command archives each paper and extracts all metadata in the same run. There is no separate enrichment pass.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Chromium
- The [GitHub CLI](https://cli.github.com/) (`gh`) signed in:

  ```bash
  gh auth login --hostname github.com
  ```

  The scraper checks `gh auth status --hostname github.com` at startup and exits if it is not signed in. There is no token fallback.
- For semantic labels: [uv](https://docs.astral.sh/uv/) and [OpenCode](https://opencode.ai/) with a configured model provider.

## Usage

Start Chromium with a separate profile and remote debugging enabled:

```bash
mkdir -p .chrome-profile
chromium \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.chrome-profile" \
  "https://academic.oup.com/bioinformatics/issue/42/Supplement_1"
```

Complete any Cloudflare verification in the visible window, then run:

```bash
bun run scrape -- \
  https://academic.oup.com/bioinformatics/issue/42/Supplement_1 \
  --chrome-debug-port 9222
```

Use a separate output directory per year so paper IDs from different volumes do not collide:

```bash
bun run scrape -- https://academic.oup.com/bioinformatics/issue/40/Supplement_1 \
  --out output/ismb-2024 --chrome-debug-port 9222
bun run scrape -- https://academic.oup.com/bioinformatics/issue/41/Supplement_1 \
  --out output/ismb-2025 --chrome-debug-port 9222
bun run scrape -- https://academic.oup.com/bioinformatics/issue/42/Supplement_1 \
  --out output/ismb-2026 --chrome-debug-port 9222
```

Results default to `output/`.

## Output

```text
output/ismb-2024/
├── metadata/            # tracked in git
│   ├── papers.json      # canonical dataset
│   ├── papers.csv       # flat table; array cells contain JSON
│   ├── errors.json      # only when a page or resource fails
│   └── <id>.json        # per-paper metadata
└── files/               # ignored by git
    └── <id>/
        ├── article.html
        ├── paper.pdf
        ├── private-metadata.json
        └── figures/
```

`private-metadata.json` holds the copied article text that is not committed: the abstract, author notes, and figure captions/alt text. It stays under the ignored `files/` tree; the tracked `metadata/` tree contains factual metadata only.

Each record in `metadata/papers.json` and `metadata/<id>.json` contains the fifteen metrics, their provenance, and the values behind the author-derived metrics:

```json
"metrics": {
  "Y": 2024,
  "A_first": 2,
  "A_senior": 3,
  "A_lead": 5,
  "A_total": 14,
  "L_lead": 2,
  "C_lead": ["United States", "United Kingdom"],
  "R": 2,
  "h_lead": 41.33,
  "M": true,
  "T": "Protein structure prediction",
  "S": 12,
  "C": 37,
  "I_open": 1,
  "I_closed": 4
},
"metrics_meta": {
  "snapshot_date": "2026-11-04",
  "github_repository": "https://github.com/owner/repo",
  "missing": []
},
"joint_first": ["Ada Lovelace", "Grace Hopper"],
"joint_senior": ["Barbara Liskov"],
"lead_affiliations": ["Lab A, Zurich, Switzerland", "Lab B, Boston, MA, USA"],
"openalex_senior_authors": [
  {
    "name": "Barbara Liskov",
    "openalex_id": "https://openalex.org/A123",
    "h_index": 41
  }
]
```

A metric that cannot be resolved is `null` and its name is listed (once) in `metrics_meta.missing`. `papers.csv` includes the fifteen metric columns plus `joint_first`, `joint_senior`, `lead_affiliations`, and `openalex_senior_authors`; null values render as empty cells and array/object values render as JSON. Author details and per-author affiliation/ORCID data stay in JSON only.

## Semantic labels

Embeddings, Leiden clusters, and OpenCode-assigned category labels live in the `semantic/` Python subproject. Scraping stays one command; semantic work runs on the HPC or at annotation time. Semantic labeling needs `uv` and `opencode` (`opencode run`) locally.

```bash
uv sync --project semantic
```

Embeddings run on one A100 through `hpc/embed.slurm`. The script only embeds and writes `output/semantic/{papers.jsonl,embeddings.npy,embedding_meta.json}`. Run `uv sync` and download the model on the HPC login/submit host; the venv is not rsynced. The script header lists the exact `rsync` and `sbatch` sequence. Local commands reuse those embeddings:

```bash
uv run --project semantic ismb-semantic embed --reuse
uv run --project semantic ismb-semantic cluster --clusters 2-20
uv run --project semantic ismb-semantic label --clusters 2-20
uv run --project semantic ismb-semantic classify
uv run --project semantic ismb-semantic export --k 12
```

Through Bun, the same commands are `bun run semantic -- cluster --clusters 2-20`. The default `--clusters 2-20` range is easily changed: use `4,6,8,12` or `12` for a subset. `export --k` selects the one cluster count used for `T`; use the `k` chosen for the analysis.

`cluster` checks that `papers.jsonl` and `embedding_meta.json` describe the same papers before writing anything. It writes per-run artifacts under the ignored `output/semantic/k-XX/` and fails if it cannot find a partition with exactly the requested number of clusters; no directory is written for a wrong count. `label` makes exactly one headless `opencode run` call per unlabeled cluster through `.opencode/agents/semantic-labeler.md`, using `opencode-go/deepseek-v4.1-flash` via OpenCode Go. There is no automatic retry: a failed or duplicate label is recorded and the command exits non-zero, leaving other clusters labeled. Rerun the same command to retry only the missing clusters. Labels are reused only when `labels/k-XX.meta.json` matches the hashes of the current cluster data, model, agent file (`.opencode/agents/<agent>.md`), and prompt; otherwise stale labels are ignored with a warning and relabeled. Add `--force` to relabel everything. Outputs are `results/semantic/labels/k-XX.json`, `results/semantic/categories/k-XX.csv`, `results/semantic/categories.csv` (`k,category,year,paper_id,title,doi`), and `results/semantic/summary.csv`.

`classify` labels every paper with `M` (true for a new method, algorithm, or model; false for evaluation-focused work). `export --k` joins `M` with the cluster labels for that `k` and writes `results/semantic/papers.json` as `doi -> {M, T}`. The scraper reads that file by default and attaches `M` and `T` to each record by DOI. All semantic LLM calls use `opencode-go/deepseek-v4.1-flash`; there is no model override.

Run the Python tests with `uv run --project semantic python -m unittest discover -s semantic/tests`.

## Options

```text
-o, --out <dir>              Output directory (default: ./output)
-c, --concurrency <n>        Parallel article tabs (default: 1)
    --delay-ms <ms>          Delay after each article (default: 1000)
    --include-non-research   Include editorials, awards, corrections
    --skip-pdfs              Skip PDFs
    --skip-html              Skip standalone article HTML
    --skip-figures           Skip figures
    --semantic <file>        DOI -> {M,T} annotations (default: results/semantic/papers.json)
    --resume                 Reuse metadata/<id>.json only if it matches the current metric schema
    --chrome-debug-port <n>  Attach to Chromium on this port
    --challenge-timeout <s>  Wait for verified content (default: 180)
    --page-retries <n>       Extra page load attempts (default: 2)
```

Keep concurrency at `1`: it is friendlier to the publisher and makes manual verification manageable.

## Notes

- Verification is manual; the scraper does not bypass CAPTCHAs or paywalls.
- Artifact extraction runs on the full article body, excluding references, and prefers recall over precision.
- `Y` is parsed from the article's `citation_publication_date`/`citation_date` metadata, with JSON-LD `datePublished` as a fallback. If no date is present, `Y` is `null` and listed in `metrics_meta.missing`.
- `L_lead` is the size of an exact minimum hitting set over the affiliation sets of the joint first and joint senior authors. The selected affiliations are stored in `lead_affiliations`. Lead authors with no extracted affiliation are ignored; if no lead author has an affiliation, `L_lead` and `lead_affiliations` are `null` and `L_lead` is listed in `metrics_meta.missing`.
- `C_lead` is the sorted set of countries parsed from the affiliations in the `L_lead` hitting set. If any selected affiliation has no parseable country, `C_lead` is `null` and listed in `metrics_meta.missing`.
- `M` and `T` are optional semantic annotations loaded from `--semantic`. `M` is true for a new method/algorithm/model and false for evaluation-focused work. `T` is the cluster label at the `k` selected during export. Missing annotations are `null` and listed in `metrics_meta.missing`.
- `R` and `h_lead` come from OpenAlex. `h_lead` is the mean OpenAlex h-index over the joint senior authors. `openalex_senior_authors` stores each resolved author's name, OpenAlex author id, and h-index; unresolved ids or unavailable h-indexes are `null`.
- An equal-contribution note that names authors is assigned by position: a matching prefix becomes joint first authors, a matching suffix joint senior authors. An unnamed note (for example `Equal contribution.`) is not guessed; the default single first/senior author is kept.
- `S`, `C`, `I_open`, and `I_closed` come from one primary `github.com` repository in the paper's artifacts, through `gh api`. The primary repository is chosen by preferring links in code/implementation availability sections, then a repository whose name matches the article title, then the first repository in article order. `C` is the number of commits on the default branch. Renamed repositories are canonicalized from `repos/<owner>/<repo>` before the issue searches. Pull requests are excluded from the issue counts. Search calls are serialized with a 2.1 s gap and retried on rate limits, because `search/issues` allows 30 requests/minute. If no repository is found, or a `gh` call still fails after retries, the metric is `null` and listed in `metrics_meta.missing`; the paper is still archived.
- If no articles are found, browser diagnostics are written to `<out>/issue-debug.{json,html,png}`.

## Tests

```bash
bun test
```

Tests use live OUP, OpenAlex, and GitHub data; there are no fixtures. Chrome on port 9222 and a signed-in `gh` are required.
