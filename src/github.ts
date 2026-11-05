export interface GitHubMetrics {
  S: number | null;
  C: number | null;
  I_open: number | null;
  I_closed: number | null;
}

export interface GitHubRepository {
  owner: string;
  repo: string;
  /** `owner/repo` */
  fullName: string;
  url: string;
}

export interface GitHubRepositoryCandidate {
  url: string;
  text?: string;
  context?: string;
  section?: string;
}

export interface GitHubFailure {
  repository: string;
  metric: keyof GitHubMetrics;
  error: string;
}

export interface GitHubResult {
  repository: GitHubRepository | null;
  metrics: GitHubMetrics;
  missing: string[];
  failures: GitHubFailure[];
}

const METRIC_KEYS: (keyof GitHubMetrics)[] = ["S", "C", "I_open", "I_closed"];
const GH_TIMEOUT_MS = 30_000;

/** `search/issues` allows 30 requests per minute; 2.1 s keeps us safely below. */
const SEARCH_MIN_GAP_MS = 2_100;
const SEARCH_MAX_RETRIES = 3;
const RATE_LIMIT_FALLBACK_MS = 65_000;

const RESERVED_GITHUB_PATHS = new Set([
  "about",
  "apps",
  "collections",
  "explore",
  "features",
  "login",
  "marketplace",
  "orgs",
  "pricing",
  "settings",
  "sponsors",
  "topics",
  "users"
]);

interface ThrottleOptions {
  minGapMs: number;
  maxRetries: number;
  fallbackDelayMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Serializes GitHub search calls and retries them on rate-limit errors.
 * The queue is module-level, so concurrent papers also share the limit.
 */
export class SearchThrottle {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ThrottleOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.enqueue(task);
      } catch (error) {
        if (attempt >= this.options.maxRetries || !isRateLimitError(error)) {
          throw error;
        }
        await this.sleep(retryDelayMs(error, this.options.fallbackDelayMs, this.now));
      }
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.options.minGapMs - (this.now() - this.lastStart);
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return task();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const searchThrottle = new SearchThrottle({
  minGapMs: SEARCH_MIN_GAP_MS,
  maxRetries: SEARCH_MAX_RETRIES,
  fallbackDelayMs: RATE_LIMIT_FALLBACK_MS
});

/**
 * Verify that the GitHub CLI is installed and signed in to github.com. The
 * scraper has no token fallback: `gh auth login --hostname github.com` is a
 * hard requirement.
 */
export async function assertGitHubCliAuthenticated(): Promise<void> {
  if (!Bun.which("gh")) {
    throw new Error(
      "GitHub CLI (`gh`) is required but was not found on PATH. " +
        "Install it from https://cli.github.com/ and run `gh auth login --hostname github.com`."
    );
  }

  try {
    await runGitHubCli(["auth", "status", "--hostname", "github.com"]);
  } catch (error) {
    throw new Error(
      "GitHub CLI is not signed in to github.com. " +
        "Run `gh auth login --hostname github.com` and retry. " +
        `Details: ${message(error)}`
    );
  }
}

/** Pick the first `github.com` repository URL and reduce it to `owner/repo`. */
export function parseGitHubRepository(repositoryUrls: string[]): GitHubRepository | null {
  for (const raw of repositoryUrls) {
    const parsed = parseGitHubUrl(raw);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Rank every distinct repository candidate by the same evidence used to pick
 * the primary repository. The first entry is the primary; later entries are
 * fallbacks when the primary no longer resolves.
 */
export function rankGitHubRepositoryCandidates(
  candidates: GitHubRepositoryCandidate[],
  paperTitle = ""
): GitHubRepository[] {
  const titleKey = normalizeKey(paperTitle);
  const byRepository = new Map<string, { repository: GitHubRepository; score: number }>();

  for (const candidate of candidates) {
    const repository = parseGitHubUrl(candidate.url);
    if (!repository) continue;

    // The same repository can appear as an anchor in the introduction and as
    // plain text in the availability section. Keep its strongest evidence.
    const score = scoreRepositoryCandidate(repository, candidate, titleKey);
    const key = repository.fullName.toLowerCase();
    const current = byRepository.get(key);
    if (current === undefined || score > current.score) {
      byRepository.set(key, { repository, score });
    }
  }

  return [...byRepository.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.repository);
}

/**
 * Choose the most likely main repository. Preference order:
 * code/implementation availability link, repository name matching the paper
 * title, and finally the first repository in article order.
 */
export function selectPrimaryGitHubRepository(
  candidates: GitHubRepositoryCandidate[],
  paperTitle = ""
): GitHubRepository | null {
  return rankGitHubRepositoryCandidates(candidates, paperTitle)[0] ?? null;
}

const CODE_WORDS = /\b(?:code|software|implementation|script|scripts|source)\b/;
const DATA_WORDS = /\b(?:data|dataset|datasets)\b/;
const AVAILABILITY_WORDS = /\b(?:availability|available)\b/;

const REPOSITORY_NOISE_WORDS = new Set([
  "data",
  "dataset",
  "datasets",
  "database",
  "experiment",
  "experiments",
  "experimental",
  "test",
  "tests",
  "testing",
  "run",
  "runs",
  "running",
  "workflow",
  "workflows",
  "script",
  "scripts",
  "analysis",
  "analyses",
  "benchmark",
  "benchmarks",
  "benchmarking",
  "reproducibility",
  "reproduce",
  "reproduction",
  "paper",
  "supplementary",
  "supplement",
  "supp",
  "shared",
  "example",
  "examples",
  "demo",
  "tutorial",
  "old",
  "archive",
  "archived",
  "fork",
  "main",
  "master",
  "src",
  "source",
  "code",
  "software",
  "github",
  "repo",
  "repository",
  "project",
  "tool",
  "tools",
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "using",
  "based"
]);

const REPOSITORY_PENALTY_WORDS = new Set([
  "data",
  "dataset",
  "datasets",
  "database",
  "experiment",
  "experiments",
  "test",
  "tests",
  "run",
  "runs",
  "workflow",
  "workflows",
  "script",
  "scripts",
  "analysis",
  "analyses",
  "benchmark",
  "benchmarks",
  "reproducibility",
  "reproduce",
  "paper",
  "supplementary",
  "supp",
  "shared",
  "example",
  "demo",
  "tutorial",
  "old",
  "archive",
  "fork"
]);

function scoreRepositoryCandidate(
  repository: GitHubRepository,
  candidate: GitHubRepositoryCandidate,
  titleKey: string
): number {
  const section = normalizeKey(candidate.section ?? "");
  const context = normalizeKey(candidate.context ?? "");
  let score = 0;

  const sectionHasCode = CODE_WORDS.test(section);
  const sectionHasData = DATA_WORDS.test(section);
  const sectionHasAvailability = AVAILABILITY_WORDS.test(section);

  if (sectionHasCode) score += 40;
  if (sectionHasAvailability) score += 8;
  if (sectionHasData && !sectionHasCode) score -= 25;

  const contextHasCode = CODE_WORDS.test(context);
  const contextHasData = DATA_WORDS.test(context);
  if (contextHasCode) score += 12;
  if (contextHasData && !contextHasCode) score -= 10;

  const words = repository.repo.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const repositoryKey = normalizeKey(repository.repo);
  if (repositoryKey.length >= 4 && titleKey.includes(repositoryKey)) {
    score += 35;
  } else {
    const matches = words.filter(
      (word) =>
        word.length >= 4 &&
        !REPOSITORY_NOISE_WORDS.has(word) &&
        titleKey.includes(word)
    );
    score += Math.min(matches.length, 3) * 10;
  }

  for (const word of words) {
    if (REPOSITORY_PENALTY_WORDS.has(word)) score -= 15;
  }
  const meaningfulWords = words.filter((word) => !REPOSITORY_NOISE_WORDS.has(word));
  score -= Math.max(0, meaningfulWords.length - 1) * 3;

  return score;
}

function normalizeKey(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Oxford Academic sometimes rewrites underscores in a linked repository name
 * as separate path segments: `owner/rna/_small/_parsimony`. Join that shape
 * back into `rna_small_parsimony`. Normal deep paths such as `/tree/main` are
 * left untouched.
 */
export function collapseUnderscoreEscapedRepoSegments(
  repoSegment: string,
  remainingSegments: string[]
): string {
  if (
    remainingSegments.length > 0 &&
    remainingSegments.every((segment) => /^_[A-Za-z0-9_.-]+$/.test(segment))
  ) {
    return repoSegment + remainingSegments.join("");
  }
  return repoSegment;
}

export function parseGitHubUrl(raw: string): GitHubRepository | null {
  let url: URL;
  try {
    url = new URL(cleanRepositoryUrl(raw));
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com") return null;

  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponentSafe);
  if (parts.length < 2) return null;
  if (RESERVED_GITHUB_PATHS.has(parts[0].toLowerCase())) return null;

  const owner = parts[0];
  const repo = collapseUnderscoreEscapedRepoSegments(
    parts[1].replace(/\.git$/i, ""),
    parts.slice(2)
  );
  if (!isValidOwner(owner) || !isValidRepo(repo)) return null;

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`
  };
}

/**
 * `gh api repos/<owner>/<repo>` follows repository renames. Read the canonical
 * `full_name` in the same call so the issue searches below use the new name.
 */
export async function fetchRepositoryDetails(
  fullName: string
): Promise<{ repository: GitHubRepository; stars: number }> {
  const output = await runGitHubCli([
    "api",
    `repos/${fullName}`,
    "--jq",
    "[.full_name, .stargazers_count] | @tsv"
  ]);
  const tab = output.indexOf("\t");
  if (tab <= 0) {
    throw new Error(`Unexpected repository details for ${fullName}: ${JSON.stringify(output)}`);
  }

  const canonicalName = output.slice(0, tab).trim();
  const repository = parseGitHubUrl(`https://github.com/${canonicalName}`);
  if (!repository) {
    throw new Error(`Unexpected canonical repository for ${fullName}: ${JSON.stringify(canonicalName)}`);
  }

  return {
    repository,
    stars: parseCount(output.slice(tab + 1), "stargazers_count", fullName)
  };
}

/** Issue count via search, excluding pull requests. `type:issue` is mandatory. */
export async function fetchIssueCount(
  fullName: string,
  state: "open" | "closed"
): Promise<number> {
  const output = await searchThrottle.run(() =>
    runGitHubCli([
      "api",
      "-X",
      "GET",
      "search/issues",
      "-f",
      `q=repo:${fullName} type:issue state:${state}`,
      "--jq",
      ".total_count"
    ])
  );
  return parseCount(output, `${state} issues`, fullName);
}

/**
 * Commit count via the commits endpoint. With `per_page=1`, the page number in
 * the last `Link` header is the total number of commits; a single-page repo has
 * no `Link` header, so the one-item body is counted instead.
 */
export async function fetchCommitCount(fullName: string): Promise<number> {
  let output: string;
  try {
    output = await runGitHubCli([
      "api",
      "-X",
      "GET",
      `repos/${fullName}/commits`,
      "-f",
      "per_page=1",
      "--include"
    ]);
  } catch (error) {
    // GitHub returns 409 for a repository with no commits at all.
    if (/Git Repository is empty/i.test(message(error))) return 0;
    throw error;
  }
  return parseCommitCount(output, fullName);
}

/**
 * Fetch S, C, I_open, and I_closed for the primary repository. Individual `gh`
 * failures are recorded in `failures` and null the affected metric; they never
 * throw, so a paper is never discarded because GitHub failed.
 */
export async function collectGitHubMetrics(
  repositoryUrls: string[]
): Promise<GitHubResult> {
  const byName = new Map<string, GitHubRepository>();
  for (const raw of repositoryUrls) {
    const repository = parseGitHubUrl(raw);
    if (repository && !byName.has(repository.fullName.toLowerCase())) {
      byName.set(repository.fullName.toLowerCase(), repository);
    }
  }
  const candidates = [...byName.values()];
  if (candidates.length === 0) {
    return {
      repository: null,
      metrics: { S: null, C: null, I_open: null, I_closed: null },
      missing: [...METRIC_KEYS],
      failures: []
    };
  }

  const metrics: GitHubMetrics = { S: null, C: null, I_open: null, I_closed: null };
  const failed = new Set<keyof GitHubMetrics>();
  const failures: GitHubFailure[] = [];
  let repository = candidates[0];
  let details: { repository: GitHubRepository; stars: number } | null = null;
  let detailsError: unknown = null;

  // Resolve stars and the canonical name together: a renamed repository still
  // answers `repos/<old-name>`, but `search/issues` only accepts the new name.
  // If a candidate is gone (404), try the next-ranked repository instead.
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    repository = candidate;
    try {
      details = await fetchRepositoryDetails(candidate.fullName);
      repository = details.repository;
      break;
    } catch (error) {
      detailsError = error;
      if (!isNotFoundError(error) || index === candidates.length - 1) break;
    }
  }

  if (details) {
    metrics.S = details.stars;
  } else {
    failed.add("S");
    failures.push({
      repository: repository.fullName,
      metric: "S",
      error: message(detailsError ?? "Could not resolve repository")
    });
  }

  await Promise.all(
    (["C", "I_open", "I_closed"] as const).map(async (key) => {
      try {
        metrics[key] =
          key === "C"
            ? await fetchCommitCount(repository.fullName)
            : await fetchIssueCount(
                repository.fullName,
                key === "I_open" ? "open" : "closed"
              );
      } catch (error) {
        failed.add(key);
        failures.push({
          repository: repository.fullName,
          metric: key,
          error: message(error)
        });
      }
    })
  );

  return {
    repository,
    metrics,
    missing: METRIC_KEYS.filter((key) => failed.has(key)),
    failures
  };
}

/** Layer GitHub values on top without touching A_*, R, h_lead, or other metrics. */
export function mergeGitHubMetrics<T extends object>(
  metrics: T,
  github: GitHubResult,
  existingMissing: string[] = []
): { metrics: T & GitHubMetrics; missing: string[] } {
  return {
    metrics: { ...metrics, ...github.metrics },
    missing: unique([...existingMissing, ...github.missing])
  };
}

async function runGitHubCli(args: string[]): Promise<string> {
  const result = await spawnGh(args);

  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `exit code ${result.exitCode}`;
    throw new Error(`gh ${args.join(" ")} failed: ${detail}`);
  }

  return result.stdout.trim();
}

async function spawnGh(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const child = Bun.spawn(["gh", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(GH_TIMEOUT_MS)
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);

    return { stdout, stderr, exitCode };
  } catch (error) {
    throw new Error(`Could not run \`gh ${args.join(" ")}\`: ${message(error)}`);
  }
}

function parseCount(output: string, label: string, fullName: string): number {
  const value = Number(output);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Unexpected ${label} for ${fullName}: ${JSON.stringify(output)}`
    );
  }
  return value;
}

/** Parse a `gh api --include` commits response into the commit count. */
export function parseCommitCount(output: string, fullName = "repository"): number {
  const [headers, ...bodyParts] = output.split(/\r?\n\r?\n/);
  const link = headers
    .split(/\r?\n/)
    .reverse()
    .find((line) => /^link:/i.test(line));

  if (link) {
    const lastPage = link.match(/[?&]page=(\d+)>;\s*rel="last"/i);
    if (lastPage) return parseCount(lastPage[1], "commit count", fullName);
  }

  const body = bodyParts.join("\n\n").trim();

  try {
    const value = JSON.parse(body);
    if (Array.isArray(value)) return value.length;
  } catch {}

  throw new Error(
    `Unexpected commit response for ${fullName}: ${JSON.stringify(output.slice(0, 300))}`
  );
}

/** A repository endpoint 404 means the candidate is gone, so try the next one. */
function isNotFoundError(error: unknown): boolean {
  return /HTTP\s*404\b|gh:\s*Not Found/i.test(message(error));
}

/** `gh` reports rate limits in stderr; only search calls are retried. */
function isRateLimitError(error: unknown): boolean {
  return /rate limit|secondary rate|too many requests|abuse detection|HTTP 429/i.test(
    message(error)
  );
}

function retryDelayMs(
  error: unknown,
  fallbackMs: number,
  now: () => number
): number {
  const text = message(error);

  const retryAfter = text.match(/retry-after:\s*(\d+)/i);
  if (retryAfter) return Number(retryAfter[1]) * 1000;

  const reset = text.match(/x-ratelimit-reset:\s*(\d+)/i);
  if (reset) {
    const waitMs = Number(reset[1]) * 1000 - now();
    if (waitMs > 0) return waitMs;
  }

  return fallbackMs;
}

function cleanRepositoryUrl(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^[<(\[{'\"]+/, "")
    .replace(/\\_/g, "_")
    .replace(/[)>\]}\"'\.,;:]+$/g, "");
}

function isValidOwner(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value);
}

function isValidRepo(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
