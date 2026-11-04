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
- Optional: [Poppler](https://poppler.freedesktop.org/) `pdftotext` for resolving unnamed equal-contribution notes from the PDF first page.

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
output/
├── papers.json          # canonical dataset
├── papers.csv           # flat table; array cells contain JSON
├── errors.json          # only when a page or resource fails
└── papers/<id>/
    ├── metadata.json
    ├── article.html
    ├── paper.pdf
    └── figures/
```

Each record in `papers.json` and `papers/<id>/metadata.json` contains the nine metrics and their provenance:

```json
"metrics": {
  "A_first": 2,
  "A_senior": 3,
  "A_lead": 5,
  "A_total": 14,
  "R": 2,
  "h_lead": 41.33,
  "S": 12,
  "I_open": 1,
  "I_closed": 4
},
"metrics_meta": {
  "snapshot_date": "2026-11-04",
  "github_repository": "https://github.com/owner/repo",
  "missing": []
}
```

A metric that cannot be resolved is `null` and its name is listed (once) in `metrics_meta.missing`. `papers.csv` includes the nine metric columns `A_first`, `A_senior`, `A_lead`, `A_total`, `R`, `h_lead`, `S`, `I_open`, `I_closed`; null values render as empty cells. Author details stay in JSON only.

## Options

```text
-o, --out <dir>              Output directory (default: ./output)
-c, --concurrency <n>        Parallel article tabs (default: 1)
    --delay-ms <ms>          Delay after each article (default: 1000)
    --include-non-research   Include editorials, awards, corrections
    --skip-pdfs              Skip PDFs
    --skip-html              Skip standalone article HTML
    --skip-figures           Skip figures
    --resume                 Reuse papers/<id>/metadata.json only if it matches the current metric schema
    --chrome-debug-port <n>  Attach to Chromium on this port
    --challenge-timeout <s>  Wait for verified content (default: 180)
    --page-retries <n>       Extra page load attempts (default: 2)
```

Keep concurrency at `1`: it is friendlier to the publisher and makes manual verification manageable.

## Notes

- Verification is manual; the scraper does not bypass CAPTCHAs or paywalls.
- Artifact extraction runs on the full article body, excluding references, and prefers recall over precision.
- `R` and `h_lead` come from OpenAlex. `h_lead` is the mean OpenAlex h-index over the joint senior authors.
- An unnamed equal-contribution or joint-author note (for example `Equal contribution.`) is resolved by reading the PDF first page with `pdftotext` and matching the footnote marker (for example `†`) to author names. When this succeeds, `joint_source` is `"pdf"`. The fallback is optional: if `pdftotext`, the PDF, or an unambiguous marker is unavailable, the default single first/senior author is kept and `joint_source` is `null`.
- `S`, `I_open`, and `I_closed` come from the first `github.com` repository in the paper's artifacts, through `gh api`. Renamed repositories are canonicalized from `repos/<owner>/<repo>` before the issue searches. Pull requests are excluded from the issue counts. Search calls are serialized with a 2.1 s gap and retried on rate limits, because `search/issues` allows 30 requests/minute. If no repository is found, or a `gh` call still fails after retries, the metric is `null` and listed in `metrics_meta.missing`; the paper is still archived.
- If no articles are found, browser diagnostics are written to `<out>/issue-debug.{json,html,png}`.

## Tests

```bash
bun test
```

Tests use live OUP, OpenAlex, and GitHub data; there are no fixtures. Chrome on port 9222 and a signed-in `gh` are required.
