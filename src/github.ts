export interface GitHubMetrics {
  S: number | null;
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

const METRIC_KEYS: (keyof GitHubMetrics)[] = ["S", "I_open", "I_closed"];
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

export function parseGitHubUrl(raw: string): GitHubRepository | null {
  let url: URL;
  try {
    url = new URL(raw);
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
  const repo = parts[1].replace(/\.git$/i, "");
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
 * Fetch S, I_open, and I_closed for the primary repository. Individual `gh`
 * failures are recorded in `failures` and null the affected metric; they never
 * throw, so a paper is never discarded because GitHub failed.
 */
export async function collectGitHubMetrics(
  repositoryUrls: string[]
): Promise<GitHubResult> {
  const parsed = parseGitHubRepository(repositoryUrls);
  if (!parsed) {
    return {
      repository: null,
      metrics: { S: null, I_open: null, I_closed: null },
      missing: [...METRIC_KEYS],
      failures: []
    };
  }

  const metrics: GitHubMetrics = { S: null, I_open: null, I_closed: null };
  const failed = new Set<keyof GitHubMetrics>();
  const failures: GitHubFailure[] = [];
  let repository = parsed;

  // Resolve stars and the canonical name together: a renamed repository still
  // answers `repos/<old-name>`, but `search/issues` only accepts the new name.
  try {
    const details = await fetchRepositoryDetails(parsed.fullName);
    repository = details.repository;
    metrics.S = details.stars;
  } catch (error) {
    failed.add("S");
    failures.push({
      repository: parsed.fullName,
      metric: "S",
      error: message(error)
    });
  }

  await Promise.all(
    (["I_open", "I_closed"] as const).map(async (key) => {
      try {
        metrics[key] = await fetchIssueCount(
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
