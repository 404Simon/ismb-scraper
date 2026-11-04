import { nameKey, type AuthorDetail, type AuthorMetrics } from "./authors";

const OPENALEX_BASE = "https://api.openalex.org";
const REQUEST_TIMEOUT_MS = 20_000;
const AUTHORS_PER_REQUEST = 50;

export interface OpenAlexAuthorship {
  /** OpenAlex author id, e.g. https://openalex.org/A123. */
  authorId: string;
  /** Author name as printed on the paper. */
  name: string;
  displayName: string;
  orcid: string | null;
}

export interface OpenAlexWork {
  citedByCount: number;
  authorships: OpenAlexAuthorship[];
}

export interface OpenAlexMetrics {
  R: number | null;
  h_lead: number | null;
}

export interface OpenAlexSeniorAuthor {
  /** Name as printed on the paper. */
  name: string;
  /** Resolved OpenAlex author id, or null when the name/ORCID did not resolve uniquely. */
  openalex_id: string | null;
  /** OpenAlex h-index for this author, or null when it was unavailable. */
  h_index: number | null;
}

export interface OpenAlexResult {
  metrics: OpenAlexMetrics;
  missing: string[];
  /** Per joint-senior-author resolution behind `h_lead`. */
  senior_authors: OpenAlexSeniorAuthor[];
}

export interface OpenAlexRequest {
  doi: string;
  jointSenior: string[];
  authorsDetail: AuthorDetail[];
}

export interface MergedMetrics extends AuthorMetrics, OpenAlexMetrics {}

/** Fetch an OpenAlex work by DOI. Returns null when OpenAlex has no work for it. */
export async function fetchOpenAlexWork(doi: string): Promise<OpenAlexWork | null> {
  const cleanDoi = normalizeDoi(doi);
  if (!cleanDoi || /\s/.test(cleanDoi)) return null;

  const json = await openAlexJson(
    `/works/doi:${cleanDoi}?select=cited_by_count,authorships`
  );
  if (json === null) return null;
  return parseWork(json);
}

/** Fetch summary_stats.h_index for OpenAlex author ids. Missing h-indexes are absent from the map. */
export async function fetchAuthorHIndexes(
  authorIds: string[]
): Promise<Map<string, number>> {
  const ids = [...new Set(authorIds.filter(Boolean))];
  const hIndexes = new Map<string, number>();

  for (let offset = 0; offset < ids.length; offset += AUTHORS_PER_REQUEST) {
    const batch = ids.slice(offset, offset + AUTHORS_PER_REQUEST);
    const filter = `openalex_id:${batch.join("|")}`;
    const json = await openAlexJson(
      `/authors?filter=${filter}&select=id,summary_stats&per-page=${batch.length}`
    );
    if (!asRecord(json)) continue;

    for (const result of asArray(json.results)) {
      const id = stringValue(result.id);
      const hIndex = numberValue(asRecord(result.summary_stats)?.h_index);
      if (id && hIndex !== null) hIndexes.set(id, hIndex);
    }
  }

  return hIndexes;
}

/**
 * Resolve joint senior names to OpenAlex author ids.
 * Exact normalized names are tried first; ORCID is only used when the name is
 * missing or ambiguous. Two different author ids for one name are rejected.
 */
export function resolveSeniorAuthorIds(
  seniorNames: string[],
  work: OpenAlexWork,
  authorsDetail: AuthorDetail[]
): { authorIds: string[]; unresolved: string[] } {
  const authorIds: string[] = [];
  const unresolved: string[] = [];

  for (const name of seniorNames) {
    const authorId = resolveSeniorAuthorId(name, work, authorsDetail);
    if (authorId) authorIds.push(authorId);
    else unresolved.push(name);
  }

  return { authorIds: unique(authorIds), unresolved };
}

function resolveSeniorAuthorId(
  name: string,
  work: OpenAlexWork,
  authorsDetail: AuthorDetail[]
): string | null {
  const key = nameKey(name);
  const nameMatches = unique(
    work.authorships
      .filter((authorship) =>
        nameKey(authorship.name) === key ||
        nameKey(authorship.displayName) === key
      )
      .map((authorship) => authorship.authorId)
  );

  if (nameMatches.length === 1) return nameMatches[0];

  const orcid = orcidForName(name, authorsDetail);
  if (!orcid) return null;

  const orcidMatches = unique(
    work.authorships
      .filter((authorship) => normalizeOrcid(authorship.orcid) === orcid)
      .map((authorship) => authorship.authorId)
  );
  return orcidMatches.length === 1 ? orcidMatches[0] : null;
}

/** Fetch R and h_lead. Work fetch failures throw; missing values are reported in `missing`. */
export async function collectOpenAlexMetrics(
  request: OpenAlexRequest
): Promise<OpenAlexResult> {
  const work = await fetchOpenAlexWork(request.doi);
  if (!work) return missingBoth();

  const missing: string[] = [];
  if (!Number.isInteger(work.citedByCount) || work.citedByCount < 0) missing.push("R");

  const seniorAuthors = request.jointSenior.map((name) => ({
    name,
    openalex_id: resolveSeniorAuthorId(name, work, request.authorsDetail)
  }));
  const authorIds = unique(
    seniorAuthors
      .map((author) => author.openalex_id)
      .filter((id): id is string => id !== null)
  );
  const unresolved = seniorAuthors
    .filter((author) => author.openalex_id === null)
    .map((author) => author.name);

  const hIndexes = authorIds.length
    ? await fetchAuthorHIndexes(authorIds).catch(() => null)
    : new Map<string, number>();
  const resolvedAuthors = seniorAuthors.map((author) => ({
    ...author,
    h_index: author.openalex_id ? hIndexes?.get(author.openalex_id) ?? null : null
  }));

  const values = authorIds.map((id) => hIndexes?.get(id));
  const complete =
    unresolved.length === 0 &&
    authorIds.length > 0 &&
    hIndexes !== null &&
    values.every((value) => value !== undefined);
  if (!complete) missing.push("h_lead");

  return {
    metrics: {
      R: missing.includes("R") ? null : work.citedByCount,
      h_lead: complete ? mean(values as number[]) : null
    },
    missing,
    senior_authors: resolvedAuthors
  };
}

/** Keep the author counts and layer the OpenAlex values on top. */
export function mergePaperMetrics(
  authorMetrics: AuthorMetrics,
  openAlex: OpenAlexResult,
  existingMissing: string[] = []
): { metrics: MergedMetrics; missing: string[] } {
  return {
    metrics: { ...authorMetrics, ...openAlex.metrics },
    missing: unique([...existingMissing, ...openAlex.missing])
  };
}

function missingBoth(): OpenAlexResult {
  return {
    metrics: { R: null, h_lead: null },
    missing: ["R", "h_lead"],
    senior_authors: []
  };
}

function mean(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 100) / 100;
}

function parseWork(json: unknown): OpenAlexWork {
  const work = asRecord(json);
  if (!work) throw new Error("OpenAlex returned an unexpected work payload");

  const citedByCount = numberValue(work.cited_by_count);
  if (citedByCount === null) throw new Error("OpenAlex work is missing cited_by_count");

  const authorships: OpenAlexAuthorship[] = [];
  for (const item of asArray(work.authorships)) {
    const authorship = asRecord(item);
    const author = asRecord(authorship?.author);
    const authorId = stringValue(author?.id);
    if (!authorId) continue;

    const displayName = stringValue(author?.display_name) ?? "";
    authorships.push({
      authorId,
      name: stringValue(authorship?.raw_author_name) ?? displayName,
      displayName,
      orcid: stringValue(author?.orcid)
    });
  }

  return {
    citedByCount,
    authorships
  };
}

async function openAlexJson(path: string): Promise<unknown> {
  const url = new URL(`${OPENALEX_BASE}${path}`);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ismb-scraper/0.1"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `OpenAlex is unreachable at ${url.origin}${url.pathname}: ${message(error)}`
    );
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `OpenAlex returned HTTP ${response.status} for ${url.pathname}${url.search}`
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`OpenAlex returned invalid JSON for ${url.pathname}: ${message(error)}`);
  }
}

function orcidForName(name: string, authorsDetail: AuthorDetail[]): string | null {
  const key = nameKey(name);
  const orcids = unique(
    authorsDetail
      .filter((author) => nameKey(author.name) === key)
      .map((author) => normalizeOrcid(author.orcid))
      .filter((orcid): orcid is string => orcid !== null)
  );
  return orcids.length === 1 ? orcids[0] : null;
}

export function normalizeDoi(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

function normalizeOrcid(value: string | null | undefined): string | null {
  const clean = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, "")
    .replace(/\/+$/, "")
    .toUpperCase();
  return clean || null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, any>)
    : null;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
