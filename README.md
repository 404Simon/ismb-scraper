# ISMB scraper

Archive an Oxford Academic *Bioinformatics* proceedings issue (for example, ISMB) into a paper-centric dataset: metadata, authors, DOI, abstract, PDF, cleaned article HTML, figures, and reproducibility artifacts.

Requires [Bun](https://bun.sh) 1.4+, Chromium, and the [GitHub CLI](https://cli.github.com/) (`gh`) signed in with `gh auth login --hostname github.com`. The scraper checks `gh auth status --hostname github.com` before every run and exits if it is not signed in; there is no token fallback.

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
gh auth login   # once per machine; verify with `gh auth status`
bun run scrape -- \
  https://academic.oup.com/bioinformatics/issue/42/Supplement_1 \
  --chrome-debug-port 9222
```

Results are written to `output/`.

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

## Options

```text
-o, --out <dir>              Output directory (default: ./output)
-c, --concurrency <n>        Parallel article tabs (default: 1)
    --delay-ms <ms>          Delay after each article (default: 1000)
    --include-non-research   Include editorials, awards, corrections
    --skip-pdfs              Skip PDFs
    --skip-html              Skip standalone article HTML
    --skip-figures           Skip figures
    --resume                 Reuse existing papers/<id>/metadata.json
    --chrome-debug-port <n>  Attach to Chromium on this port
    --challenge-timeout <s>  Wait for verified content (default: 180)
    --page-retries <n>       Extra page load attempts (default: 2)
```

Keep concurrency at `1`: it is friendlier to the publisher and makes manual verification manageable.

## Notes

- Verification is manual; the scraper does not bypass CAPTCHAs or paywalls.
- Artifact extraction runs on the full article body, excluding references, and prefers recall over precision.
- `S`, `I_open`, and `I_closed` come from the first `github.com` repository in the paper's artifacts, through `gh api`. Pull requests are excluded from the issue counts. Search calls are serialized with a 2.1 s gap and retried on rate limits, because `search/issues` allows 30 requests/minute. If no repository is found, or a `gh` call still fails after retries, the metric is `null` and listed in `metrics_meta.missing`; the paper is still archived.
- If no articles are found, browser diagnostics are written to `output/issue-debug.{json,html,png}`.

## Tests

```bash
bun test
```
