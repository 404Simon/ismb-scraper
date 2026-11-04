#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  authorExtractionScript,
  buildAuthorMetadata,
  type AuthorDetail,
  type AuthorMetrics
} from "./authors";
import { startChromeTabProxy } from "./chrome";
import {
  assertGitHubCliAuthenticated,
  collectGitHubMetrics,
  mergeGitHubMetrics,
  type GitHubMetrics
} from "./github";
import {
  collectOpenAlexMetrics,
  mergePaperMetrics,
  normalizeDoi,
  type OpenAlexResult
} from "./openalex";
import { pageStateScript, readReadyPage } from "./page-readiness";

interface IssueArticle {
  title: string;
  url: string;
  section: string;
}

type ArtifactKey =
  | "repositories"
  | "zenodo"
  | "figshare"
  | "dryad"
  | "osf"
  | "software_heritage"
  | "code_ocean"
  | "packages"
  | "datasets"
  | "models"
  | "containers"
  | "other";

interface Artifacts extends Record<ArtifactKey, string[]> {}

interface ArtifactCandidate {
  url: string;
  text: string;
  context: string;
}

interface FigureCandidate {
  id: string;
  token: string;
  url: string;
  alt: string;
  caption: string;
}

interface SavedFigure {
  source_url: string;
  path: string | null;
  alt: string;
  caption: string;
}

interface PaperFiles {
  html: string | null;
  pdf: string | null;
  figures: SavedFigure[];
}

interface PaperMetrics extends AuthorMetrics, GitHubMetrics {
  R: number | null;
  h_lead: number | null;
}

interface MetricsMeta {
  snapshot_date: string;
  github_repository: string | null;
  missing: string[];
}

interface PaperRecord {
  paper_name: string;
  authors: string[];
  authors_detail: AuthorDetail[];
  author_notes: string[];
  joint_first: string[];
  joint_senior: string[];
  has_group_author: boolean;
  metrics: PaperMetrics;
  metrics_meta: MetricsMeta;
  doi: string;
  abstract: string;
  article_url: string;
  link_to_pdf: string;
  artifacts: Artifacts;
  files: PaperFiles;
}

interface BrowserArticleData {
  title: string;
  authors: string[];
  authorsDetail: AuthorDetail[];
  authorNotes: string[];
  doi: string;
  abstract: string;
  pdfUrl: string;
  artifactCandidates: ArtifactCandidate[];
  articleHtml: string;
  figures: FigureCandidate[];
}

interface Failure {
  title: string;
  url: string;
  stage: string;
  error: string;
}

interface ScrapeResult {
  record: PaperRecord;
  pdfSaved: boolean;
  figuresSaved: number;
  warnings: Failure[];
}

const METRIC_NAMES = [
  "A_first",
  "A_senior",
  "A_lead",
  "A_total",
  "R",
  "h_lead",
  "S",
  "I_open",
  "I_closed"
] as const;

type MetricName = (typeof METRIC_NAMES)[number];

const ARTIFACT_KEYS: ArtifactKey[] = [
  "repositories",
  "zenodo",
  "figshare",
  "dryad",
  "osf",
  "software_heritage",
  "code_ocean",
  "packages",
  "datasets",
  "models",
  "containers",
  "other"
];

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    out: { type: "string", short: "o", default: "./output" },
    concurrency: { type: "string", short: "c", default: "1" },
    "delay-ms": { type: "string", default: "1000" },
    "include-non-research": { type: "boolean", default: false },
    "skip-pdfs": { type: "boolean", default: false },
    "skip-html": { type: "boolean", default: false },
    "skip-figures": { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    "chrome-debug-port": { type: "string" },
    "challenge-timeout": { type: "string", default: "180" },
    "page-retries": { type: "string", default: "2" },
    help: { type: "boolean", short: "h", default: false }
  }
});

function usage(exitCode = 0): never {
  const text = `
ismb-scrape — archive an Oxford Academic Bioinformatics proceedings issue

Usage:
  bun run scrape -- <issue-url> [options]
  ismb-scrape <issue-url> [options]

Example:
  bun run scrape -- \\
    https://academic.oup.com/bioinformatics/issue/42/Supplement_1 \\
    --chrome-debug-port 9222

Options:
  -o, --out <dir>              Output directory (default: ./output)
  -c, --concurrency <n>        Article tabs processed in parallel (default: 1)
      --delay-ms <ms>          Delay after each article per worker (default: 1000)
      --include-non-research   Also include Editorial/Awards/Correction items
      --skip-pdfs              Do not download publisher PDFs
      --skip-html              Do not save standalone article HTML
      --skip-figures           Do not download article figures
      --resume                 Reuse papers/<id>/metadata.json when it matches the current metric schema
      --chrome-debug-port <n> Attach to visible Chrome with remote debugging
      --challenge-timeout <s> Seconds to wait for verified, ready content (default: 180)
      --page-retries <n>      Extra attempts for pages that fail to load (default: 2)
  -h, --help                   Show this help

Output:
  <out>/papers.json            Canonical structured index
  <out>/papers.csv             Flat convenience table; array cells contain JSON arrays
  <out>/papers/<id>/metadata.json
  <out>/papers/<id>/article.html
  <out>/papers/<id>/paper.pdf
  <out>/papers/<id>/figures/*
  <out>/errors.json            Only when a page/resource fails
`;
  console.log(text.trim());
  process.exit(exitCode);
}

if (values.help) usage(0);
const issueUrl = positionals[0];
if (!issueUrl) usage(1);

let parsedIssue: URL;
try {
  parsedIssue = new URL(issueUrl);
} catch {
  console.error(`Invalid URL: ${issueUrl}`);
  process.exit(1);
}

if (parsedIssue.hostname !== "academic.oup.com") {
  console.error("This scraper currently targets academic.oup.com issue pages.");
  process.exit(1);
}

const issueMatch = parsedIssue.pathname.match(
  /^\/bioinformatics\/issue\/([^/]+)\/([^/?#]+)/i
);
if (!issueMatch) {
  console.error(
    "Expected an OUP Bioinformatics issue URL such as " +
      "https://academic.oup.com/bioinformatics/issue/42/Supplement_1"
  );
  process.exit(1);
}

try {
  await assertGitHubCliAuthenticated();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const [, volume, issue] = issueMatch;
const outDir = resolve(String(values.out));
const papersDir = join(outDir, "papers");
const concurrency = positiveInt(String(values.concurrency), "--concurrency");
const delayMs = nonNegativeInt(String(values["delay-ms"]), "--delay-ms");
const includeNonResearch = Boolean(values["include-non-research"]);
const downloadPdfs = !Boolean(values["skip-pdfs"]);
const saveHtml = !Boolean(values["skip-html"]);
const downloadFigures = !Boolean(values["skip-figures"]);
const resume = Boolean(values.resume);
const challengeTimeoutMs =
  nonNegativeInt(String(values["challenge-timeout"]), "--challenge-timeout") * 1000;
const pageRetries = nonNegativeInt(String(values["page-retries"]), "--page-retries");
const chromeDebugPort = values["chrome-debug-port"]
  ? positiveInt(String(values["chrome-debug-port"]), "--chrome-debug-port")
  : null;
const chromeUrl = chromeDebugPort
  ? startChromeTabProxy(await getChromeWebSocketUrl(chromeDebugPort))
  : null;
const chromeBackend = chromeUrl
  ? { type: "chrome" as const, url: chromeUrl }
  : "chrome";
const interactiveChrome = chromeDebugPort !== null;

await mkdir(papersDir, { recursive: true });

console.log(`Issue: ${parsedIssue.href}`);
console.log(`Output: ${outDir}`);
console.log(
  interactiveChrome
    ? `Attaching to visible Chrome on port ${chromeDebugPort}...`
    : "Opening issue in headless Chromium..."
);

const issueView = new Bun.WebView({
  backend: chromeBackend,
  width: 1440,
  height: 1200
});

let issueArticles: IssueArticle[];
try {
  issueArticles = await readReadyPage(issueView, parsedIssue.href, "issue", async () => {
    const articles = await discoverIssueArticles(issueView, parsedIssue.href, volume, issue);
    if (!articles.length) throw new Error("Issue content is present but article discovery returned no links");
    return articles;
  }, { interactive: interactiveChrome, timeoutMs: challengeTimeoutMs, retries: pageRetries });
} catch (error) {
  await writeIssueDiagnostics(issueView, outDir);
  throw error;
} finally {
  issueView.close();
}

if (!includeNonResearch) {
  issueArticles = issueArticles.filter((article) => !isNonResearchSection(article.section));
}

if (issueArticles.length === 0) {
  console.error(
    "No article links were found. OUP may have changed its markup or presented a browser challenge."
  );
  process.exit(2);
}

console.log(
  `Found ${issueArticles.length} article(s)` +
    (includeNonResearch ? "." : " after excluding editorial/award/correction sections.")
);

const failures: Failure[] = [];
const snapshotDate = new Date().toISOString().slice(0, 10);
const results = await mapLimit(issueArticles, concurrency, async (article, index) => {
  const prefix = `[${index + 1}/${issueArticles.length}]`;
  const paperId = articleIdFromUrl(article.url);
  const paperDir = join(papersDir, paperId);
  const metadataPath = join(paperDir, "metadata.json");

  console.log(`${prefix} ${article.title}`);

  if (resume && (await Bun.file(metadataPath).exists())) {
    try {
      const record: unknown = await Bun.file(metadataPath).json();
      if (isResumableRecord(record)) {
        console.log(`${prefix} resumed from ${relativePath(outDir, metadataPath)}`);
        return record;
      }
      console.warn(`${prefix} resume metadata is missing current metric fields; scraping again.`);
    } catch {
      console.warn(`${prefix} resume metadata unreadable; scraping again.`);
    }
  }

  try {
    const result = await scrapeArticle(article, paperDir, outDir, snapshotDate);
    failures.push(...result.warnings);
    const artifactCount = ARTIFACT_KEYS.reduce(
      (sum, key) => sum + result.record.artifacts[key].length,
      0
    );
    console.log(
      `${prefix} done` +
        `${result.pdfSaved ? " + PDF" : ""}` +
        `${result.figuresSaved ? ` + ${result.figuresSaved} figure(s)` : ""}` +
        `; ${artifactCount} artifact(s)`
    );
    return result.record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${prefix} FAILED: ${message}`);
    failures.push({ title: article.title, url: article.url, stage: "article", error: message });
    return null;
  } finally {
    if (delayMs > 0) await Bun.sleep(delayMs);
  }
});

const successfulRecords = results.filter((row): row is PaperRecord => row !== null);
await Bun.write(join(outDir, "papers.json"), JSON.stringify(successfulRecords, null, 2) + "\n");
await Bun.write(join(outDir, "papers.csv"), toCsv(successfulRecords));

if (failures.length > 0) {
  await Bun.write(join(outDir, "errors.json"), JSON.stringify(failures, null, 2) + "\n");
} else if (await Bun.file(join(outDir, "errors.json")).exists()) {
  await Bun.write(join(outDir, "errors.json"), "[]\n");
}

console.log("");
console.log(`Wrote ${successfulRecords.length} paper(s) to ${join(outDir, "papers.json")}`);
console.log(`Paper archive: ${papersDir}`);
if (failures.length > 0) {
  console.log(`Warnings/failures: ${failures.length} (see ${join(outDir, "errors.json")})`);
  process.exitCode = 3;
}

async function scrapeArticle(
  article: IssueArticle,
  paperDir: string,
  archiveRoot: string,
  snapshotDate: string
): Promise<ScrapeResult> {
  const view = new Bun.WebView({
    backend: chromeBackend,
    width: 1440,
    height: 1200
  });

  const warnings: Failure[] = [];

  try {
    await mkdir(paperDir, { recursive: true });
    const data = await readReadyPage(view, article.url, "article", async () => {
      const extracted = (await view.evaluate(articleExtractorScript(article.url))) as BrowserArticleData;
      if (!extracted?.title?.trim() || !extracted.articleHtml?.trim() ||
          !Array.isArray(extracted.artifactCandidates) || !Array.isArray(extracted.figures) ||
          !Array.isArray(extracted.authorsDetail) || !Array.isArray(extracted.authorNotes)) {
        throw new Error("Article extraction returned incomplete content; waiting for the page to finish loading");
      }
      return extracted;
    }, { interactive: interactiveChrome, timeoutMs: challengeTimeoutMs, retries: pageRetries });
    const paperName = data.title || article.title;
    const artifacts = classifyArtifacts(data.artifactCandidates, article.url);

    const files: PaperFiles = {
      html: null,
      pdf: null,
      figures: []
    };

    let pdfSaved = false;
    if (downloadPdfs && data.pdfUrl) {
      const pdfPath = join(paperDir, "paper.pdf");
      try {
        const resource = await downloadBrowserResource(view, data.pdfUrl);
        validatePdf(resource.bytes, data.pdfUrl);
        await Bun.write(pdfPath, resource.bytes);
        files.pdf = relativePath(archiveRoot, pdfPath);
        pdfSaved = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push({
          title: paperName,
          url: data.pdfUrl,
          stage: "pdf",
          error: message
        });
      }
    }

    const authorMetadata = buildAuthorMetadata(
      { authors: data.authorsDetail, notes: data.authorNotes },
      data.authors
    );
    const doi = normalizeDoi(data.doi);
    const openAlex = await openAlexMetricsFor(
      paperName,
      doi,
      authorMetadata.joint_senior,
      authorMetadata.authors_detail,
      article.url,
      warnings
    );
    const mergedMetrics = mergePaperMetrics(authorMetadata.metrics, openAlex);
    const github = await collectGitHubMetrics(artifacts.repositories);
    for (const failure of github.failures) {
      console.warn(`[github] ${paperName}: ${failure.error}`);
      warnings.push({
        title: paperName,
        url: failure.repository
          ? `https://github.com/${failure.repository}`
          : article.url,
        stage: "github",
        error: failure.error
      });
    }
    const finalMetrics = mergeGitHubMetrics(
      mergedMetrics.metrics,
      github,
      mergedMetrics.missing
    );

    let html = buildStandaloneHtml(paperName, article.url, data.articleHtml);
    let figuresSaved = 0;

    const figureDir = join(paperDir, "figures");
    if (downloadFigures && data.figures.length > 0) {
      await mkdir(figureDir, { recursive: true });
    }

    for (let index = 0; index < data.figures.length; index++) {
      const figure = data.figures[index];
      let savedPath: string | null = null;
      let replacementUrl = figure.url;

      if (downloadFigures) {
        try {
          const resource = await downloadBrowserResource(view, figure.url);
          validateImage(resource.bytes, resource.contentType, figure.url);
          const ext = inferImageExtension(resource.bytes, resource.contentType, figure.url);
          const filename = `figure-${String(index + 1).padStart(3, "0")}${ext}`;
          const destination = join(figureDir, filename);
          await Bun.write(destination, resource.bytes);
          savedPath = relativePath(archiveRoot, destination);
          replacementUrl = `figures/${filename}`;
          figuresSaved++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push({
            title: paperName,
            url: figure.url,
            stage: "figure",
            error: message
          });
        }
      }

      html = html.replaceAll(figure.token, escapeHtmlAttribute(replacementUrl));
      files.figures.push({
        source_url: figure.url,
        path: savedPath,
        alt: normalizeWhitespace(figure.alt),
        caption: normalizeWhitespace(figure.caption)
      });
    }

    if (saveHtml) {
      const htmlPath = join(paperDir, "article.html");
      await Bun.write(htmlPath, html);
      files.html = relativePath(archiveRoot, htmlPath);
    }

    const record: PaperRecord = {
      paper_name: paperName,
      authors: unique(data.authors.map(normalizeWhitespace).filter(Boolean)),
      ...authorMetadata,
      metrics: finalMetrics.metrics,
      metrics_meta: {
        snapshot_date: snapshotDate,
        github_repository: github.repository?.url ?? null,
        missing: finalMetrics.missing
      },
      doi,
      abstract: normalizeWhitespace(data.abstract),
      article_url: article.url,
      link_to_pdf: data.pdfUrl || "",
      artifacts,
      files
    };

    await Bun.write(join(paperDir, "metadata.json"), JSON.stringify(record, null, 2) + "\n");

    return { record, pdfSaved, figuresSaved, warnings };
  } finally {
    view.close();
  }
}

async function openAlexMetricsFor(
  title: string,
  doi: string,
  jointSenior: string[],
  authorsDetail: AuthorDetail[],
  articleUrl: string,
  warnings: Failure[]
): Promise<OpenAlexResult> {
  try {
    return await collectOpenAlexMetrics({ doi, jointSenior, authorsDetail });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[openalex] ${title}: ${message}`);
    warnings.push({
      title,
      url: doi ? `https://doi.org/${doi}` : articleUrl,
      stage: "openalex",
      error: message
    });
    return { metrics: { R: null, h_lead: null }, missing: ["R", "h_lead"] };
  }
}

function articleExtractorScript(url: string): string {
  return String.raw`
(() => {
  if (!(${pageStateScript("article", url)}).ready) throw new Error("Article content is not ready for extraction");
  const qMeta = (names) => {
    for (const name of names) {
      const el = document.querySelector('meta[name="' + name + '" i], meta[property="' + name + '" i]');
      const value = el && el.getAttribute("content");
      if (value) return value.trim();
    }
    return "";
  };

  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const text = (el) => normalizeText(el && el.textContent ? el.textContent : "");

  let jsonLd = {};
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(node.textContent || "null");
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const found = candidates.find((x) => x && typeof x === "object" &&
        /ScholarlyArticle|Article/i.test(String(x["@type"] || "")));
      if (found) { jsonLd = found; break; }
    } catch {}
  }

  const title =
    qMeta(["citation_title", "dc.Title", "DC.Title"]) ||
    String(jsonLd.headline || jsonLd.name || "") ||
    text(document.querySelector("h1"));

  let authors = [...document.querySelectorAll('meta[name="citation_author" i]')]
    .map((m) => (m.getAttribute("content") || "").trim())
    .filter(Boolean);

  if (!authors.length && Array.isArray(jsonLd.author)) {
    authors = jsonLd.author
      .map((a) => typeof a === "string" ? a : (a && a.name) || "")
      .filter(Boolean);
  }

  const doi =
    qMeta(["citation_doi", "dc.Identifier", "DC.Identifier", "prism.doi"]) ||
    String(jsonLd.identifier || "");

  function extractAbstract() {
    const meta = qMeta(["citation_abstract", "dc.Description", "DC.Description"]);
    if (meta && meta.length > 80) return meta;

    const selectors = [
      "section.abstract",
      ".abstractInFull",
      ".abstract",
      "#abstract",
      '[class*="abstract"]'
    ];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const t = text(el).replace(/^Abstract\s*/i, "").trim();
        if (t.length > 80) return t;
      }
    }

    const heading = [...document.querySelectorAll("h2,h3,h4,h5")]
      .find((h) => /^abstract\s*$/i.test(text(h)));
    if (!heading) return String(jsonLd.description || "");

    const section = heading.closest("section");
    if (section) return text(section).replace(/^Abstract\s*/i, "").trim();

    const chunks = [];
    let el = heading.nextElementSibling;
    while (el && !/^H[1-5]$/.test(el.tagName)) {
      const t = text(el);
      if (t) chunks.push(t);
      el = el.nextElementSibling;
    }
    return chunks.join(" ");
  }

  function findPdfUrl() {
    const fromMeta = qMeta(["citation_pdf_url"]);
    if (fromMeta) return new URL(fromMeta, location.href).href;

    const links = [...document.querySelectorAll("a[href]")];
    const preferred = links.find((a) => /\/article-pdf\//i.test(a.getAttribute("href") || ""));
    if (preferred) return new URL(preferred.href, location.href).href;

    const byText = links.find((a) => /^PDF(?:\s|$)/i.test(text(a)) && /pdf/i.test(a.href));
    if (byText) return new URL(byText.href, location.href).href;

    const anyPdf = links.find((a) => /\.pdf(?:$|[?#])/i.test(a.href));
    return anyPdf ? new URL(anyPdf.href, location.href).href : "";
  }

  function articleRoot() {
    const root = document.querySelector(
      "article, .article-body, .js-article-body, .widget-ArticleFulltext, main"
    );
    if (!root) throw new Error("Article content disappeared during navigation");
    return root;
  }

  function removeReferences(root) {
    for (const el of root.querySelectorAll(
      '#references, .references, .ref-list, .reference-list, [class*="reference-list"], [id*="references"]'
    )) el.remove();

    // Fallback for reference sections without predictable classes/ids.
    for (const heading of [...root.querySelectorAll("h2,h3,h4,h5")]) {
      if (!/^(references|bibliography|literature cited)\s*$/i.test(text(heading))) continue;
      const section = heading.closest("section");
      if (section) section.remove();
    }
  }

  function candidateContext(el) {
    const container = el && el.closest
      ? el.closest("p,li,dd,dt,figcaption,section,div")
      : null;
    let context = text(container || el);
    if (context.length > 900) context = context.slice(0, 900);
    return context;
  }

  function extractArtifactCandidates() {
    const copy = articleRoot().cloneNode(true);
    removeReferences(copy);

    const candidates = [];
    const seen = new Set();
    const add = (url, label, context) => {
      url = String(url || "").trim();
      if (!url) return;
      const key = url + "\n" + String(context || "").slice(0, 200);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        url,
        text: normalizeText(label).slice(0, 500),
        context: normalizeText(context).slice(0, 900)
      });
    };

    for (const a of copy.querySelectorAll("a[href]")) {
      const raw = a.getAttribute("href") || "";
      if (/^(?:javascript|mailto|tel):/i.test(raw)) continue;
      try {
        add(new URL(raw, location.href).href, text(a), candidateContext(a));
      } catch {}
    }

    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    let node;
    const urlRe = /https?:\/\/[^\s<>\]\[{}"']+/gi;
    const nakedKnownRe = /(?:^|[\s(])((?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|gitee\.com|git\.sr\.ht)\/[^\s<>\]\[{}"']+)/gi;
    while ((node = walker.nextNode())) {
      const rawText = node.nodeValue || "";
      const parent = node.parentElement;
      const context = candidateContext(parent);
      for (const match of rawText.matchAll(urlRe)) add(match[0], match[0], context);
      for (const match of rawText.matchAll(nakedKnownRe)) {
        const raw = match[1];
        add(/^https?:\/\//i.test(raw) ? raw : "https://" + raw.replace(/^www\./i, ""), raw, context);
      }
    }

    const plain = copy.textContent || "";
    for (const match of plain.matchAll(/10\.5281\/zenodo\.\d+(?:\.\d+)?/gi)) {
      add("https://doi.org/" + match[0], match[0], "Zenodo DOI mentioned in article text");
    }
    for (const match of plain.matchAll(/10\.6084\/m9\.figshare\.\d+(?:\.v\d+)?/gi)) {
      add("https://doi.org/" + match[0], match[0], "Figshare DOI mentioned in article text");
    }
    for (const match of plain.matchAll(/10\.5061\/dryad\.[A-Za-z0-9._-]+/gi)) {
      add("https://doi.org/" + match[0], match[0], "Dryad DOI mentioned in article text");
    }
    for (const match of plain.matchAll(/\bGSE\d+\b/gi)) {
      add("https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=" + match[0].toUpperCase(), match[0], "GEO accession mentioned in article text");
    }
    for (const match of plain.matchAll(/\bPRJNA\d+\b/gi)) {
      add("https://www.ncbi.nlm.nih.gov/bioproject/" + match[0].toUpperCase(), match[0], "BioProject accession mentioned in article text");
    }
    for (const match of plain.matchAll(/\bPRJ(?:EB|DB)\d+\b/gi)) {
      add("https://www.ebi.ac.uk/ena/browser/view/" + match[0].toUpperCase(), match[0], "ENA project accession mentioned in article text");
    }
    for (const match of plain.matchAll(/\b(?:SRP|ERP|DRP)\d+\b/gi)) {
      add("https://www.ebi.ac.uk/ena/browser/view/" + match[0].toUpperCase(), match[0], "Sequence-read project accession mentioned in article text");
    }
    for (const match of plain.matchAll(/\bE-MTAB-\d+\b/gi)) {
      add("https://www.ebi.ac.uk/biostudies/arrayexpress/studies/" + match[0].toUpperCase(), match[0], "ArrayExpress accession mentioned in article text");
    }

    return candidates;
  }

  function absoluteUrl(raw) {
    raw = String(raw || "").trim();
    if (!raw) return "";
    if (raw.startsWith("#")) return raw;
    if (/^(?:data|blob|mailto|tel):/i.test(raw)) return raw;
    if (/^javascript:/i.test(raw)) return "";
    try {
      const u = new URL(raw, location.href);
      if (u.origin === location.origin && u.pathname === location.pathname &&
          u.search === location.search && u.hash) return u.hash;
      return u.href;
    } catch {
      return raw;
    }
  }

  function largestSrcsetUrl(srcset) {
    if (!srcset) return "";
    const items = srcset.split(",").map((part) => {
      const bits = part.trim().split(/\s+/);
      const descriptor = bits[1] || "1x";
      let score = 1;
      if (/\d+w$/i.test(descriptor)) score = Number.parseInt(descriptor, 10) || 1;
      else if (/[\d.]+x$/i.test(descriptor)) score = (Number.parseFloat(descriptor) || 1) * 10000;
      return { url: bits[0] || "", score };
    }).filter((x) => x.url);
    items.sort((a, b) => b.score - a.score);
    return items[0] ? items[0].url : "";
  }

  function bestLiveImageUrl(img) {
    const picture = img.closest("picture");
    const sourceSets = picture
      ? [...picture.querySelectorAll("source[srcset]")].map((s) => s.getAttribute("srcset") || "")
      : [];
    const options = [
      ...sourceSets.map(largestSrcsetUrl),
      largestSrcsetUrl(img.getAttribute("srcset") || ""),
      img.currentSrc,
      img.getAttribute("data-src"),
      img.getAttribute("data-original"),
      img.getAttribute("src")
    ].filter(Boolean);
    for (const raw of options) {
      const abs = absoluteUrl(raw);
      if (abs && !/^data:/i.test(abs)) return abs;
    }
    return "";
  }

  function extractArticleHtml() {
    const root = articleRoot();
    const liveImages = [...root.querySelectorAll("img")];
    for (let i = 0; i < liveImages.length; i++) {
      liveImages[i].setAttribute("data-ismb-live-index", String(i));
    }

    const copy = root.cloneNode(true);
    for (const img of liveImages) img.removeAttribute("data-ismb-live-index");

    for (const el of copy.querySelectorAll(
      'script,noscript,style,form,button,nav,[class*="toolbar"],[class*="social-share"],[class*="share-tools"]'
    )) el.remove();

    for (const el of copy.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      }
    }

    for (const a of copy.querySelectorAll("a[href]")) {
      const href = absoluteUrl(a.getAttribute("href") || "");
      if (href) a.setAttribute("href", href);
      else a.removeAttribute("href");
    }

    for (const el of copy.querySelectorAll("[src]")) {
      const value = absoluteUrl(el.getAttribute("src") || "");
      if (value) el.setAttribute("src", value);
    }
    for (const el of copy.querySelectorAll("[poster]")) {
      const value = absoluteUrl(el.getAttribute("poster") || "");
      if (value) el.setAttribute("poster", value);
    }
    for (const el of copy.querySelectorAll("[srcset]")) {
      const normalized = (el.getAttribute("srcset") || "")
        .split(",")
        .map((part) => {
          const bits = part.trim().split(/\s+/);
          const u = absoluteUrl(bits.shift() || "");
          return u ? [u, ...bits].join(" ") : "";
        })
        .filter(Boolean)
        .join(", ");
      if (normalized) el.setAttribute("srcset", normalized);
      else el.removeAttribute("srcset");
    }

    const figures = [];
    const figureByUrl = new Map();
    let figureNumber = 0;
    const allCloneImages = [...copy.querySelectorAll("img")];
    const figureImages = allCloneImages.filter((img) =>
      img.closest('figure,.fig,.figure,[class*="fig"],[id^="F"],[id^="fig"]')
    );
    const selected = figureImages.length ? figureImages : allCloneImages;

    for (const img of selected) {
      const index = Number.parseInt(img.getAttribute("data-ismb-live-index") || "-1", 10);
      const live = index >= 0 ? liveImages[index] : null;
      const url = live ? bestLiveImageUrl(live) : absoluteUrl(img.getAttribute("src") || "");
      img.removeAttribute("data-ismb-live-index");
      if (!url || /^data:/i.test(url)) continue;

      let known = figureByUrl.get(url);
      if (!known) {
        figureNumber++;
        const id = "fig-" + String(figureNumber).padStart(3, "0");
        const token = "__ISMB_LOCAL_" + id.toUpperCase().replace(/-/g, "_") + "__";
        const container = img.closest('figure,.fig,.figure,[class*="fig"],[id^="F"],[id^="fig"]');
        const captionNode = container && container.querySelector("figcaption,.caption,.fig-caption,[class*=caption]");
        known = {
          id,
          token,
          url,
          alt: img.getAttribute("alt") || "",
          caption: text(captionNode)
        };
        figureByUrl.set(url, known);
        figures.push(known);
      }

      img.setAttribute("src", known.token);
      img.removeAttribute("srcset");
      img.removeAttribute("data-src");
      img.removeAttribute("data-original");
      const picture = img.closest("picture");
      if (picture) for (const source of picture.querySelectorAll("source")) source.remove();
    }

    for (const img of copy.querySelectorAll("img[data-ismb-live-index]")) {
      img.removeAttribute("data-ismb-live-index");
    }

    return { html: copy.outerHTML, figures };
  }

  const archived = extractArticleHtml();
  const authorData = ${authorExtractionScript()};

  return {
    title,
    authors,
    authorsDetail: authorData.authors,
    authorNotes: authorData.notes,
    doi,
    abstract: extractAbstract(),
    pdfUrl: findPdfUrl(),
    artifactCandidates: extractArtifactCandidates(),
    articleHtml: archived.html,
    figures: archived.figures
  };
})()
`;
}

function classifyArtifacts(candidates: ArtifactCandidate[], articleUrl: string): Artifacts {
  const artifacts = emptyArtifacts();

  for (const candidate of candidates) {
    const classified = classifyArtifact(candidate, articleUrl);
    if (!classified) continue;
    artifacts[classified.key].push(classified.url);
  }

  for (const key of ARTIFACT_KEYS) artifacts[key] = unique(artifacts[key]);
  return artifacts;
}

function classifyArtifact(
  candidate: ArtifactCandidate,
  articleUrl: string
): { key: ArtifactKey; url: string } | null {
  const raw = cleanCandidateUrl(candidate.url);
  if (!raw) return null;

  let u: URL;
  try {
    u = new URL(raw, articleUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(u.protocol)) return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = decodeURIComponentSafe(u.pathname).toLowerCase();
  const doiPath = host === "doi.org" ? path.replace(/^\//, "") : "";
  const context = `${candidate.text}\n${candidate.context}`.toLowerCase();

  if (isRepositoryHost(host)) {
    const normalized = normalizeRepositoryUrl(u);
    return normalized ? { key: "repositories", url: normalized } : null;
  }

  if (host === "zenodo.org" || /^10\.5281\/zenodo\./i.test(doiPath)) {
    return { key: "zenodo", url: normalizeZenodoUrl(u) };
  }

  if (host.endsWith("figshare.com") || /^10\.6084\/m9\.figshare\./i.test(doiPath)) {
    return { key: "figshare", url: canonicalHttpUrl(u) };
  }

  if (host === "datadryad.org" || host.endsWith("dryad.org") || /^10\.5061\/dryad\./i.test(doiPath)) {
    return { key: "dryad", url: canonicalHttpUrl(u) };
  }

  if (host === "osf.io" || host.endsWith("osf.io")) {
    return { key: "osf", url: canonicalHttpUrl(u) };
  }

  if (host === "archive.softwareheritage.org" || host.endsWith("softwareheritage.org")) {
    return { key: "software_heritage", url: canonicalHttpUrl(u) };
  }

  if (host === "codeocean.com" || host.endsWith("codeocean.com")) {
    return { key: "code_ocean", url: canonicalHttpUrl(u) };
  }

  if (isPackageUrl(u)) {
    return { key: "packages", url: canonicalHttpUrl(u) };
  }

  if (isContainerUrl(host, path)) {
    return { key: "containers", url: canonicalHttpUrl(u) };
  }

  if (host === "huggingface.co") {
    if (/^\/datasets\//i.test(u.pathname)) return { key: "datasets", url: canonicalHttpUrl(u) };
    if (/^\/spaces\//i.test(u.pathname)) return { key: "other", url: canonicalHttpUrl(u) };
    return { key: "models", url: normalizeHuggingFaceModelUrl(u) };
  }

  if (isDatasetUrl(host, path)) {
    return { key: "datasets", url: canonicalHttpUrl(u) };
  }

  if (isClearlyNonArtifactLink(u, articleUrl)) return null;

  if (hasArtifactContext(context) || looksLikeDownloadableArtifact(path)) {
    return { key: "other", url: canonicalHttpUrl(u) };
  }

  return null;
}

function isRepositoryHost(host: string): boolean {
  return (
    host === "github.com" ||
    host.endsWith(".github.com") ||
    host === "gitlab.com" ||
    host.startsWith("gitlab.") ||
    host.includes(".gitlab.") ||
    host === "bitbucket.org" ||
    host === "codeberg.org" ||
    host === "git.sr.ht" ||
    host === "gitee.com" ||
    host.startsWith("git.")
  );
}

function normalizeRepositoryUrl(input: URL): string {
  const host = input.hostname.toLowerCase().replace(/^www\./, "");
  let parts = input.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponentSafe(part));

  if (parts.length < 2) return "";

  const cleanRepoSegment = (value: string) =>
    value
      .replace(/\.git$/i, "")
      .split(/[\s,;]+/)[0]
      .replace(/[).,:;]+$/g, "");

  if (["github.com", "bitbucket.org", "codeberg.org", "gitee.com", "git.sr.ht"].includes(host)) {
    parts = [parts[0], cleanRepoSegment(parts[1])];
  } else if (host.includes("gitlab")) {
    const dash = parts.indexOf("-");
    if (dash > 1) parts = parts.slice(0, dash);
    else {
      const deepMarker = parts.findIndex((part, index) =>
        index > 1 && /^(?:tree|blob|commit|commits|issues|releases|tags|merge_requests)$/i.test(part)
      );
      if (deepMarker > 1) parts = parts.slice(0, deepMarker);
    }
    parts[parts.length - 1] = cleanRepoSegment(parts[parts.length - 1]);
  } else {
    const deepMarker = parts.findIndex((part, index) =>
      index > 1 && /^(?:tree|blob|commit|commits|issues|releases|tags)$/i.test(part)
    );
    if (deepMarker > 1) parts = parts.slice(0, deepMarker);
    parts[parts.length - 1] = cleanRepoSegment(parts[parts.length - 1]);
  }

  if (parts.length < 2 || !parts[parts.length - 1]) return "";
  return `https://${host}/${parts.map(encodeURIComponent).join("/")}`
    .replace(/%40/g, "@")
    .replace(/%3A/gi, ":");
}

function normalizeZenodoUrl(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "doi.org") return `https://doi.org/${u.pathname.replace(/^\//, "")}`;
  const match = u.pathname.match(/\/(?:record|records)\/(\d+)/i);
  if (match) return `https://zenodo.org/records/${match[1]}`;
  return canonicalHttpUrl(u);
}

function normalizeHuggingFaceModelUrl(u: URL): string {
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length >= 2) return `https://huggingface.co/${parts[0]}/${parts[1]}`;
  return canonicalHttpUrl(u);
}

function isPackageUrl(u: URL): boolean {
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.toLowerCase();
  return (
    host === "pypi.org" && path.startsWith("/project/") ||
    host === "cran.r-project.org" && (u.searchParams.has("package") || path.includes("/web/packages/")) ||
    host === "bioconductor.org" && path.includes("/packages/") ||
    host === "anaconda.org" ||
    host === "npmjs.com" ||
    host === "crates.io" ||
    host === "bioconda.github.io" && path.includes("/recipes/")
  );
}

function isContainerUrl(host: string, path: string): boolean {
  return (
    host === "hub.docker.com" ||
    host === "ghcr.io" ||
    host === "quay.io" ||
    host === "biocontainers.pro" ||
    host === "singularity-hub.org" ||
    host === "cloud.sylabs.io"
  );
}

function isDatasetUrl(host: string, path: string): boolean {
  if (host === "ncbi.nlm.nih.gov" || host === "www.ncbi.nlm.nih.gov") {
    return /\/(?:geo|sra|bioproject|biosample)\b/i.test(path);
  }
  return (
    host === "ebi.ac.uk" ||
    host === "www.ebi.ac.uk" ||
    host === "pride.ebi.ac.uk" ||
    host.endsWith("dataverse.org") ||
    host === "data.mendeley.com" ||
    host === "kaggle.com" && path.includes("/datasets/") ||
    host === "www.kaggle.com" && path.includes("/datasets/") ||
    host === "figshare.com" ||
    host === "data.niaid.nih.gov"
  );
}

function hasArtifactContext(context: string): boolean {
  return /\b(?:source\s+code|code\s+availability|data\s+availability|availability(?:\s+and\s+implementation)?|implementation|software|repository|repo\b|scripts?|reproduc(?:e|ible|ibility)|replication|benchmark|datasets?|data\s+(?:are|is|can\s+be)\s+(?:available|accessed)|trained\s+models?|model\s+weights?|checkpoints?|containers?|docker|workflow|pipeline|supplementary\s+(?:data|material|file)|archive|deposited|accession|web\s+server|demo\s+(?:site|website))\b/i.test(context);
}

function looksLikeDownloadableArtifact(path: string): boolean {
  return /\.(?:zip|tar|tgz|gz|bz2|xz|7z|csv|tsv|xlsx?|json|yaml|yml|rds|h5|h5ad|loom|pkl|pickle|joblib|onnx|pt|pth|ckpt)(?:$|\/)/i.test(path);
}

function isClearlyNonArtifactLink(u: URL, articleUrl: string): boolean {
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.toLowerCase();
  const article = new URL(articleUrl);

  if (host === "doi.org") return true;
  if (host === "pubmed.ncbi.nlm.nih.gov") return true;
  if ((host === "ncbi.nlm.nih.gov" || host === "www.ncbi.nlm.nih.gov") && path.startsWith("/pubmed")) return true;
  if (host === "academic.oup.com" && /\/bioinformatics\/(?:article|article-abstract)\//i.test(path)) {
    return u.pathname !== article.pathname;
  }
  if (host === "wikipedia.org" || host.endsWith(".wikipedia.org")) return true;
  return false;
}

function cleanCandidateUrl(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^[<(\[{'\"]+/, "")
    .replace(/[)>\]}\"']+$/g, "")
    .replace(/[.,;:]+$/g, "");
}

function canonicalHttpUrl(u: URL): string {
  u.hash = "";
  return u.href.replace(/\/$/, "");
}

function emptyArtifacts(): Artifacts {
  return {
    repositories: [],
    zenodo: [],
    figshare: [],
    dryad: [],
    osf: [],
    software_heritage: [],
    code_ocean: [],
    packages: [],
    datasets: [],
    models: [],
    containers: [],
    other: []
  };
}

function buildStandaloneHtml(title: string, sourceUrl: string, articleHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="source-url" content="${escapeHtmlAttribute(sourceUrl)}">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    box-sizing: border-box;
    max-width: 980px;
    margin: 0 auto;
    padding: 32px 24px 72px;
    font: 17px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  *, *::before, *::after { box-sizing: inherit; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.22; margin-top: 1.8em; }
  p, li { max-width: 85ch; }
  a { overflow-wrap: anywhere; }
  img, svg { max-width: 100%; height: auto; }
  figure { margin: 2rem 0; }
  figcaption, .caption, [class*="caption"] { font-size: 0.92em; line-height: 1.45; }
  table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
  th, td { padding: 0.45rem 0.6rem; vertical-align: top; }
  pre { max-width: 100%; overflow-x: auto; white-space: pre-wrap; }
  code { overflow-wrap: anywhere; }
</style>
</head>
<body>
${articleHtml}
</body>
</html>\n`;
}

async function downloadBrowserResource(
  view: Bun.WebView,
  url: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let cdpMessage = "";

  try {
    const frameTree = (await view.cdp("Page.getFrameTree")) as any;
    const frameId = frameTree?.frameTree?.frame?.id;
    if (!frameId) throw new Error("Could not determine Chrome frame id");

    const loaded = (await view.cdp("Network.loadNetworkResource", {
      frameId,
      url,
      options: { disableCache: false, includeCredentials: true }
    })) as any;

    const resource = loaded?.resource;
    if (!resource?.success || !resource?.stream) {
      throw new Error(
        `Chrome resource load failed (HTTP ${resource?.httpStatusCode ?? "?"}, ${resource?.netErrorName ?? "unknown"})`
      );
    }

    const bytes = await readCdpStream(view, resource.stream);
    const headers = resource?.headers || {};
    const contentType = String(
      headers["content-type"] || headers["Content-Type"] || resource?.mimeType || ""
    ).split(";", 1)[0].trim().toLowerCase();
    return { bytes, contentType };
  } catch (error) {
    cdpMessage = error instanceof Error ? error.message : String(error);
  }

  try {
    const cookiesResult = (await view.cdp("Network.getCookies", { urls: [url] })) as any;
    const cookies = Array.isArray(cookiesResult?.cookies) ? cookiesResult.cookies : [];
    const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
    const userAgent = String(await view.evaluate("navigator.userAgent"));

    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        Accept: "*/*",
        Referer: view.url,
        "User-Agent": userAgent,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase()
    };
  } catch (error) {
    const fetchMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`resource download failed. Chrome: ${cdpMessage}; fetch fallback: ${fetchMessage}`);
  }
}

async function readCdpStream(view: Bun.WebView, handle: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = (await view.cdp("IO.read", { handle, size: 1024 * 1024 })) as any;
      const chunk = part?.base64Encoded
        ? Buffer.from(part.data || "", "base64")
        : Buffer.from(part?.data || "", "utf8");
      chunks.push(chunk);
      total += chunk.byteLength;
      if (part?.eof) break;
    }
  } finally {
    try { await view.cdp("IO.close", { handle }); } catch {}
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function validatePdf(bytes: Uint8Array, url: string): void {
  if (bytes.byteLength < 5) throw new Error(`Empty PDF response from ${url}`);
  const magic = new TextDecoder().decode(bytes.slice(0, 5));
  if (magic !== "%PDF-") {
    throw new Error(`Response from ${url} is not a PDF (first bytes: ${JSON.stringify(magic)})`);
  }
}

function validateImage(bytes: Uint8Array, contentType: string, url: string): void {
  if (bytes.byteLength < 4) throw new Error(`Empty image response from ${url}`);
  if (/^image\//i.test(contentType)) return;

  const head = bytes.slice(0, 16);
  const ascii = new TextDecoder().decode(head);
  const isPng = head[0] === 0x89 && ascii.slice(1, 4) === "PNG";
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isGif = ascii.startsWith("GIF8");
  const isWebp = ascii.startsWith("RIFF") && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 256))).trimStart();
  const isSvg = /^<\?xml|^<svg/i.test(prefix);

  if (!(isPng || isJpeg || isGif || isWebp || isSvg)) {
    throw new Error(`Response from ${url} does not look like an image (content-type ${contentType || "unknown"})`);
  }
}

function inferImageExtension(bytes: Uint8Array, contentType: string, url: string): string {
  const byMime: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/tiff": ".tif",
    "image/bmp": ".bmp",
    "image/avif": ".avif"
  };
  if (byMime[contentType]) return byMime[contentType];

  const head = bytes.slice(0, 16);
  const ascii = new TextDecoder().decode(head);
  if (head[0] === 0x89 && ascii.slice(1, 4) === "PNG") return ".png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpg";
  if (ascii.startsWith("GIF8")) return ".gif";
  if (ascii.startsWith("RIFF") && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return ".webp";
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 256))).trimStart();
  if (/^<\?xml|^<svg/i.test(prefix)) return ".svg";

  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.(png|jpe?g|gif|webp|svg|tiff?|bmp|avif)$/i);
    if (match) return `.${match[1].toLowerCase().replace("jpeg", "jpg").replace("tiff", "tif")}`;
  } catch {}

  return ".img";
}

async function discoverIssueArticles(
  view: Bun.WebView,
  issueUrl: string,
  volume: string,
  issue: string
): Promise<IssueArticle[]> {
  const js = String.raw`
(async () => {
  if (!(${pageStateScript("issue", issueUrl)}).ready) throw new Error("Issue content is not ready for extraction");
  const issueUrl = ${JSON.stringify(issueUrl)};
  const volume = ${JSON.stringify(volume)};
  const issue = ${JSON.stringify(issue)};

  const escapeRegex = (s) => [...String(s)].map((ch) => "\\^$.*+?()[]{}|".includes(ch) ? "\\\\" + ch : ch).join("");
  const articleRe = new RegExp(
    "^/bioinformatics/(?:article|article-abstract)/" +
      escapeRegex(volume) + "/" + escapeRegex(issue) +
      "/[^/]+/\\d+/?$",
    "i"
  );

  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

  function normalizeArticleUrl(raw, baseUrl) {
    let url;
    try { url = new URL(raw, baseUrl); } catch { return ""; }
    if (url.hostname.toLowerCase() !== "academic.oup.com") return "";
    if (!articleRe.test(url.pathname)) return "";
    url.pathname = url.pathname.replace(/\/article-abstract\//i, "/article/");
    url.search = "";
    url.hash = "";
    return url.href;
  }

  function titleScore(title) {
    const t = normalizeText(title);
    if (!t) return -10000;
    if (/^(view article|abstract|extract|pdf|supplementary data)$/i.test(t)) return -1000;
    return Math.min(t.length, 500);
  }

  function collect(doc, baseUrl) {
    const rows = [];
    let section = "";

    for (const heading of doc.querySelectorAll("h2,h3,h4,h5,h6")) {
      const candidates = [...heading.querySelectorAll("a[href]")]
        .map((a) => ({
          a,
          url: normalizeArticleUrl(a.getAttribute("href") || a.href || "", baseUrl)
        }))
        .filter((x) => x.url);

      if (candidates.length) {
        const best = candidates.sort(
          (a, b) => titleScore(b.a.textContent) - titleScore(a.a.textContent)
        )[0];
        rows.push({
          title: normalizeText(best.a.textContent || heading.textContent),
          url: best.url,
          section
        });
        continue;
      }

      const headingText = normalizeText(heading.textContent);
      if (headingText && headingText.length < 180) section = headingText;
    }

    for (const a of doc.querySelectorAll("a[href]")) {
      const url = normalizeArticleUrl(a.getAttribute("href") || a.href || "", baseUrl);
      if (!url) continue;
      const container = a.closest(
        ".al-article-item-wrap, .al-article-items, article, li, [class*=article-item]"
      );
      const titleNode = container && container.querySelector("h3 a[href],h4 a[href],h5 a[href],h6 a[href]");
      const title = normalizeText(titleNode?.textContent || a.textContent);
      rows.push({ title, url, section: "" });
    }

    return rows;
  }

  const merged = new Map();
  function merge(rows) {
    for (const row of rows) {
      const previous = merged.get(row.url);
      if (!previous) {
        merged.set(row.url, row);
        continue;
      }
      if (titleScore(row.title) > titleScore(previous.title)) previous.title = row.title;
      if (!previous.section && row.section) previous.section = row.section;
    }
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    merge(collect(document, location.href));
    if (merged.size > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const fetchUrls = [
    issueUrl,
    issueUrl + (issueUrl.includes("?") ? "&" : "?") + "browseBy=volume"
  ];

  for (const url of fetchUrls) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        headers: { Accept: "text/html,application/xhtml+xml" }
      });
      if (!response.ok) continue;
      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      if (parsed) merge(collect(parsed, response.url || url));
    } catch {}
  }

  return [...merged.values()].filter((row) => row.title && row.url);
})()
`;

  return (await view.evaluate(js)) as IssueArticle[];
}

async function writeIssueDiagnostics(view: Bun.WebView, directory: string): Promise<void> {
  try {
    const info = await view.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      anchorCount: document.querySelectorAll("a[href]").length,
      headingCount: document.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
      bodyText: (document.body?.innerText || "").slice(0, 5000),
      userAgent: navigator.userAgent
    }))()`);
    await Bun.write(join(directory, "issue-debug.json"), JSON.stringify(info, null, 2) + "\n");
  } catch {}

  try {
    const html = String(await view.evaluate("document.documentElement?.outerHTML || ''"));
    if (html) await Bun.write(join(directory, "issue-debug.html"), html);
  } catch {}

  try {
    const screenshot = await view.screenshot({ format: "png", encoding: "buffer" });
    await Bun.write(join(directory, "issue-debug.png"), screenshot as Buffer);
  } catch {}

  console.error(`Browser diagnostics written to ${join(directory, "issue-debug.json")}`);
}

async function getChromeWebSocketUrl(port: number): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  let response: Response;
  try {
    response = await fetch(endpoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not connect to Chrome debugging endpoint ${endpoint}: ${message}. ` +
      `Start Chrome with --remote-debugging-port=${port} and a non-default --user-data-dir.`
    );
  }

  if (!response.ok) {
    throw new Error(`Chrome debugging endpoint returned HTTP ${response.status}: ${endpoint}`);
  }

  const info = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) {
    throw new Error(`Chrome debugging endpoint did not expose webSocketDebuggerUrl: ${endpoint}`);
  }
  return info.webSocketDebuggerUrl;
}

function isNonResearchSection(section: string): boolean {
  return /^(editorial|awards? papers?|corrections?|errata|preface)$/i.test(section.trim());
}

/**
 * A resumed record must match the current schema: every metric present and
 * either a number or null, with every null metric listed in `metrics_meta.missing`.
 * Records written before the metric extraction steps are rejected and re-scraped.
 */
function isResumableRecord(value: unknown): value is PaperRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const metrics = record.metrics;
  const meta = record.metrics_meta;
  if (metrics === null || typeof metrics !== "object") return false;
  if (meta === null || typeof meta !== "object") return false;

  const metricValues = metrics as Record<string, unknown>;
  const metaValues = meta as Record<string, unknown>;
  if (typeof metaValues.snapshot_date !== "string") return false;
  if (!("github_repository" in metaValues)) return false;
  if (!Array.isArray(metaValues.missing)) return false;

  const missing = metaValues.missing;
  if (!missing.every((name): name is string => typeof name === "string")) return false;
  if (new Set(missing).size !== missing.length) return false;

  const nullMetrics = METRIC_NAMES.filter((name) => {
    const metric = metricValues[name];
    return metric === null;
  });

  const hasAllMetrics = METRIC_NAMES.every((name) => {
    const metric = metricValues[name];
    if (name === "h_lead") {
      return metric === null ||
        (typeof metric === "number" && Number.isFinite(metric) && metric >= 0);
    }
    return metric === null ||
      (typeof metric === "number" && Number.isInteger(metric) && metric >= 0);
  });
  if (!hasAllMetrics) return false;

  const missingSet = new Set(missing);
  const missingIsAccurate =
    nullMetrics.every((name) => missingSet.has(name)) &&
    missing.every((name) => isMetricName(name) && metricValues[name] === null);
  return missingIsAccurate;
}

function isMetricName(value: string): value is MetricName {
  return (METRIC_NAMES as readonly string[]).includes(value);
}

function normalizeWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function articleIdFromUrl(value: string): string {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const articleIndex = parts.findIndex((part) => part === "article" || part === "article-abstract");
    if (articleIndex >= 0 && parts.length > articleIndex + 3) {
      return slugify(parts[articleIndex + 3]);
    }
  } catch {}
  return slugify(value).slice(0, 80) || "paper";
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return slug || "paper";
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function toCsv(rows: PaperRecord[]): string {
  const columns = [
    "paper_name",
    "authors",
    "A_first",
    "A_senior",
    "A_lead",
    "A_total",
    "R",
    "h_lead",
    "S",
    "I_open",
    "I_closed",
    "doi",
    "abstract",
    "article_url",
    "link_to_pdf",
    ...ARTIFACT_KEYS,
    "local_html",
    "local_pdf",
    "local_figures"
  ];

  const quote = (value: unknown) => {
    const s = String(value ?? "");
    return `"${s.replaceAll('"', '""')}"`;
  };

  const valuesFor = (row: PaperRecord): Record<string, string> => ({
    paper_name: row.paper_name,
    authors: JSON.stringify(row.authors),
    A_first: String(row.metrics?.A_first ?? ""),
    A_senior: String(row.metrics?.A_senior ?? ""),
    A_lead: String(row.metrics?.A_lead ?? ""),
    A_total: String(row.metrics?.A_total ?? ""),
    R: String(row.metrics?.R ?? ""),
    h_lead: String(row.metrics?.h_lead ?? ""),
    S: String(row.metrics?.S ?? ""),
    I_open: String(row.metrics?.I_open ?? ""),
    I_closed: String(row.metrics?.I_closed ?? ""),
    doi: row.doi,
    abstract: row.abstract,
    article_url: row.article_url,
    link_to_pdf: row.link_to_pdf,
    repositories: JSON.stringify(row.artifacts.repositories),
    zenodo: JSON.stringify(row.artifacts.zenodo),
    figshare: JSON.stringify(row.artifacts.figshare),
    dryad: JSON.stringify(row.artifacts.dryad),
    osf: JSON.stringify(row.artifacts.osf),
    software_heritage: JSON.stringify(row.artifacts.software_heritage),
    code_ocean: JSON.stringify(row.artifacts.code_ocean),
    packages: JSON.stringify(row.artifacts.packages),
    datasets: JSON.stringify(row.artifacts.datasets),
    models: JSON.stringify(row.artifacts.models),
    containers: JSON.stringify(row.artifacts.containers),
    other: JSON.stringify(row.artifacts.other),
    local_html: row.files.html || "",
    local_pdf: row.files.pdf || "",
    local_figures: JSON.stringify(row.files.figures.map((f) => f.path).filter(Boolean))
  });

  return [
    columns.join(","),
    ...rows.map((row) => {
      const flat = valuesFor(row);
      return columns.map((column) => quote(flat[column] || "")).join(",");
    })
  ].join("\n") + "\n";
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function positiveInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`${name} must be an integer >= 1`);
    process.exit(1);
  }
  return n;
}

function nonNegativeInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${name} must be an integer >= 0`);
    process.exit(1);
  }
  return n;
}
