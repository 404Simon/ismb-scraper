# Dataset notes - ISMB 2022-2026

Last updated: 2026-11-05.

| Year | Papers | PDFs | Figures |
|---|---:|---:|---:|
| 2022 | 47 | 47 | 233 |
| 2023 | 60 | 60 | 301 |
| 2024 | 58 | 58 | 293 |
| 2025 | 66 | 66 | 309 |
| 2026 | 64 | 64 | 299 |
| **Total** | **295** | **295** | **1,435** |

## Exclusions

Award announcements and proceedings front matter are excluded. The scraper removed them automatically for 2023-2026; 2022 was cleaned manually.

- **2022:** `btac339`, `btac338`, `btac336`, `btac337` (ISCB awards), `btac305` (proceedings), `btac218` (retracted article).
- **2023:** `btad306`, `btad307`, `btad316`, `btad318`, `btad319`
- **2024:** `btae285`, `btae286`, `btae287`, `btae288`, `btae289`
- **2025:** `btaf260`, `btaf261`, `btaf262`, `btaf263`, `btaf271`
- **2026:** `btag279`, `btag280`, `btag281`, `btag282`, `btag283`

All DOIs are `10.1093/bioinformatics/...`.

**Retracted article removed:** `btac218` - DeepCRISTL (ISMB 2022). Retracted on 10 July 2023 (`btad412`) for flaws in the evaluation methodology; the notice was later corrected (`btad562`) without changing the retraction.

## Special handling

- **Semantic `M`/`T`:** `null` for every paper until annotated. Run `bun run classify-m` to fill `M`; `T` still comes from the embedding/cluster/label/export pipeline. Missing values are listed in `metrics_meta.missing`.
- **OUP GitHub URL escaping:** underscores encoded as `/_` are normalized, e.g. `rna/_small/_parsimony` -> `rna_small_parsimony`.
- **Missing primary repository:** if the top-ranked GitHub repo returns 404, the next candidate is tried. Backfilled this way: 2024 `btae229` -> `bmarchand/rna_small_parsimony`, 2023 `btad227` -> `fredericlemoine/reprohackathon_ismb2023`.
- **OUP PDF 403:** PDFs were loaded through Chrome so OUP's redirect to the signed `watermark02.silverchair.com` URL could be followed. Fixed `btac236` (2022) and `btaf253` (2025).
- **`--resume` limitation:** it does not verify that a referenced PDF exists. If a PDF is missing after a resumed run, delete `metadata/<id>.json` for that paper and re-run with `--resume`.
- **Other null metrics:** GitHub `S`/`C`/`I_open`/`I_closed` are null where no usable repository exists (10, 10, 1, 5, 3 papers for 2022-2026); `h_lead` is null for 3, 3, 1, 1, 1 papers. All are recorded in `metrics_meta.missing`.
- **Minor metadata quirks:** 2022 `btac229` has `has_group_author: false` for "Swiss Pediatric Sepsis Study"; 2024 `btae216` expands consortium members in `authors` (134) versus `authors_detail` (12).
- **Snapshot dates:** `2026-11-04` for 2026, `2026-11-05` for 2022-2025.
