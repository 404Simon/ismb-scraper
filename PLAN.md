# PLAN: ISMB metadata extraction

## Scope

There is **one extraction command**, the existing `bun run scrape`. It must archive
the paper and extract every metadata variable in the same run. Do not add an
enrichment command or a second pass.

This iteration implements the nine reliable variables:

```text
A_first, A_senior, A_lead, A_total,
h_lead, R,
S, I_open, I_closed
```

Deferred until their definitions are settled:

- `L_lead`, `C_lead`, `C_lead` count — definition-sensitive affiliation metrics
- `M`, `T` — annotations, not metadata extraction

## Verdict

| Variable | Status | Source |
| --- | --- | --- |
| `A_first` | Implement | OUP author notes; PDF fallback |
| `A_senior` | Implement | OUP author notes; PDF fallback |
| `A_lead` | Implement | Union of first and senior sets |
| `A_total` | Implement | OUP author list |
| `L_lead` | Defer | Affiliation granularity is not settled |
| `C_lead` | Defer | Inherits `L_lead` |
| `C_lead` count | Defer | Inherits `L_lead` |
| `h_lead` | Implement | OpenAlex h-index |
| `M` | Defer | Annotation |
| `T` | Defer | Clustering label |
| `R` | Implement | OpenAlex cited-by count |
| `S` | Implement | GitHub via `gh` |
| `I_open` | Implement | GitHub via `gh` |
| `I_closed` | Implement | GitHub via `gh` |

## Hard constraints

- **GitHub CLI:** `gh` must be installed and signed in. The scrape command checks
  `gh auth status` before doing any work and exits with a clear error if the check
  fails. Document this in `README.md`. Do not add a `GITHUB_TOKEN` fallback.
- **One command:** no `enrich` command, no separate post-processing CLI.
- **Live tests:** tests hit real OUP, OpenAlex, and GitHub. There are no captured
  fixtures. Tests must fail with a clear message when Chrome or `gh` is unavailable.
- **Clean code:** small modules, explicit types, no framework, no speculative
  abstractions. The command orchestrates; modules do one job each.

## Sources

1. OUP article page, through the attached Chrome instance:
   - author names and order
   - per-author affiliations, country hints, and ORCID
   - author notes that name joint first/senior authors
2. OpenAlex:
   - `cited_by_count`
   - author IDs and `summary_stats.h_index`
3. GitHub, through `gh api`:
   - stars
   - open and closed issue counts, excluding pull requests
4. PDF first page:
   - fallback only for joint-author notes

## Data model

Add to each paper record in `papers.json` and `papers/<id>/metadata.json`:

```json
{
  "authors_detail": [
    {
      "name": "Nelly Sélem-Mojica",
      "affiliations": ["Centro de Ciencias Matemáticas, Universidad Nacional Autónoma de México, Morelia 58089, México"],
      "country_hints": ["Mexico"],
      "orcid": "https://orcid.org/0000-0003-1697-3862"
    }
  ],
  "author_notes": [
    "Lonnie R. Welch, Alastair M. Kilpatrick and Farzana Rahman Joint senior author designation."
  ],
  "joint_first": ["Arya Pradeep Menon", "Trenton Davis"],
  "joint_senior": ["Lonnie R. Welch", "Alastair M. Kilpatrick", "Farzana Rahman"],
  "metrics": {
    "A_first": 2,
    "A_senior": 3,
    "A_lead": 5,
    "A_total": 14,
    "h_lead": 41.33,
    "R": 2,
    "S": 12,
    "I_open": 1,
    "I_closed": 4
  },
  "metrics_meta": {
    "snapshot_date": "2026-11-04",
    "github_repository": "https://github.com/owner/repo",
    "missing": []
  }
}
```

Missing values are `null` and listed in `metrics_meta.missing`. Add the nine metric
columns to `papers.csv`; keep `authors_detail` in JSON only.

## Author extraction

Extract raw author data from the live OUP page:

- `.al-authors-list .al-author-name` — skip the trailing empty author-notes block
- `.linked-name` — name
- `.info-card-affilitation .aff` — affiliation strings
- `.aff .country` — country hints
- `a[id^="contrib-orcid"]` — ORCID
- `.footnote-content` — author notes

Parse jointly in TypeScript, not in the browser:

- `joint first`, `joint lead`, `co-first`, `equal contribution` when it identifies
  the first authors → `joint_first`
- `joint senior`, `joint last`, `co-senior`, `jointly supervised` → `joint_senior`
- note text that names authors: match names against the author list
- note text such as `the first two authors should be regarded as Joint First Authors`
  → take the first N authors
- notes such as `These authors contributed equally` with no names → use author
  markers if unambiguous, otherwise PDF fallback and record the source
- reject ambiguous matches; never guess

Defaults:

```text
joint_first  = [first author]
joint_senior = [last author]
A_first      = |joint_first|
A_senior     = |joint_senior|      # 0 for single-author papers
A_lead       = |joint_first ∪ joint_senior|
A_total      = |distinct OUP authors|
```

For consortia, keep the group author once and remove repeated individual authors
around it. Record `has_group_author` if present.

## OpenAlex metrics

Use the DOI work:

- `R = cited_by_count`
- senior authors = `joint_senior`
- `h_lead = mean(summary_stats.h_index)` over senior authors
- resolve a missing senior author by ORCID, then by name and affiliation
- missing h-index → `null`, listed in `metrics_meta.missing`
- `snapshot_date` is the date of the scrape

## GitHub metrics

Primary repository selection:

1. the first `github.com` repository in `artifacts.repositories`
2. if none, `S`, `I_open`, and `I_closed` are `null`

Use the CLI, not HTTP from the scraper:

```bash
gh api repos/<owner>/<repo> --jq .stargazers_count
gh api -X GET search/issues -f q='repo:<owner>/<repo> type:issue state:open' --jq .total_count
gh api -X GET search/issues -f q='repo:<owner>/<repo> type:issue state:closed' --jq .total_count
```

`type:issue` is mandatory: `open_issues_count` includes pull requests.

## Implementation order

Four sequential implement → review → fix loops. Each accepted step gets its own
local commit. No push until the whole feature is complete.

1. **Author metadata**
   - add `src/authors.ts` and live tests
   - extend the page extractor and `PaperRecord`
   - compute `A_first`, `A_senior`, `A_lead`, `A_total`
2. **OpenAlex metrics**
   - add `src/openalex.ts` and live tests
   - compute `R` and `h_lead`
3. **GitHub metrics**
   - add `src/github.ts` and live tests
   - add the `gh auth status` hard check
   - compute `S`, `I_open`, `I_closed`
4. **Integration and archive**
   - merge metrics into one record, CSV, and `metrics_meta.missing`
   - update `README.md` with the new fields and `gh` requirement
   - re-scrape all 188 papers into `output/`
   - audit coverage and sample real papers

## Tests

Live network only.

Author tests against these real papers:

- `10.1093/bioinformatics/btae212` — joint first and joint senior
- `10.1093/bioinformatics/btag326` — joint first
- `10.1093/bioinformatics/btag278` — joint lead and joint senior
- `10.1093/bioinformatics/btae232` — “first two authors” note without names

Assertions must cover the named sets and the four derived counts.

OpenAlex tests:

- resolve a real DOI
- assert `R` is a non-negative integer
- assert `h_lead` is a positive number for a paper with known senior profiles

GitHub tests:

- resolve a known repository through `gh`
- assert stars and issue counts are non-negative integers
- assert the issue query excludes pull requests on a repository with known PRs

## Validation after re-scrape

- Report coverage for every metric across all 188 papers.
- Manually inspect at least 20 papers with joint-author notes.
- Inspect every paper with no GitHub repository and every paper with multiple
  repositories.
- Confirm every value is either a number or `null` with an entry in `missing`.
- Confirm `bun test` passes against the live services.
