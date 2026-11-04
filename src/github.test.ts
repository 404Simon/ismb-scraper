import { describe, expect, test } from "bun:test";
import {
  assertGitHubCliAuthenticated,
  collectGitHubMetrics,
  fetchIssueCount,
  mergeGitHubMetrics,
  parseGitHubRepository,
  parseGitHubUrl,
  SearchThrottle,
  type GitHubResult
} from "./github";

const LIVE_TIMEOUT_MS = 60_000;
const FAKE_REPOSITORY = "ismb-scraper-does-not-exist-xyz/nope";

let authCheck: Promise<void> | null = null;

/** Every live test calls this so a missing or signed-out `gh` fails clearly. */
function requireGh(): Promise<void> {
  authCheck ??= assertGitHubCliAuthenticated();
  return authCheck;
}

async function ghCount(args: string[]): Promise<number> {
  const child = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  const value = Number(stdout.trim());
  if (!Number.isInteger(value)) {
    throw new Error(`gh ${args.join(" ")} returned a non-integer: ${stdout.trim()}`);
  }
  return value;
}

describe("live GitHub metrics", () => {
  test("the GitHub CLI is installed and signed in", async () => {
    await expect(requireGh()).resolves.toBeUndefined();
  }, LIVE_TIMEOUT_MS);

  test("a real corpus repository yields stars and issue counts", async () => {
    await requireGh();

    const result = await collectGitHubMetrics([
      "https://github.com/lubianat/compbio-on-wiki"
    ]);

    expect(result.repository?.fullName).toBe("lubianat/compbio-on-wiki");
    expect(result.missing).toEqual([]);
    expect(result.failures).toEqual([]);

    for (const value of [
      result.metrics.S,
      result.metrics.I_open,
      result.metrics.I_closed
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
  }, LIVE_TIMEOUT_MS);

  test("a renamed repository alias resolves to its canonical name", async () => {
    await requireGh();

    const result = await collectGitHubMetrics([
      "https://github.com/vshiv18/sigmoni"
    ]);

    expect(result.repository?.fullName).toBe("vikshiv/sigmoni");
    expect(result.repository?.url).toBe("https://github.com/vikshiv/sigmoni");
    expect(result.missing).toEqual([]);
    expect(result.failures).toEqual([]);

    for (const value of [
      result.metrics.S,
      result.metrics.I_open,
      result.metrics.I_closed
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
    expect(result.metrics.I_open).toBeGreaterThanOrEqual(0);
    expect(result.metrics.I_closed).toBeGreaterThanOrEqual(0);
  }, LIVE_TIMEOUT_MS);

  test("issue counts exclude pull requests on cli/cli", async () => {
    await requireGh();

    const openIssuesIncludingPrs = await ghCount([
      "api",
      "repos/cli/cli",
      "--jq",
      ".open_issues_count"
    ]);
    const openPullRequests = await ghCount([
      "api",
      "-X",
      "GET",
      "search/issues",
      "-f",
      "q=repo:cli/cli type:pr state:open",
      "--jq",
      ".total_count"
    ]);
    const openIssues = await fetchIssueCount("cli/cli", "open");

    expect(openPullRequests).toBeGreaterThan(0);
    expect(openIssues).toBeLessThanOrEqual(openIssuesIncludingPrs);
    expect(openIssues).toBeLessThan(openIssuesIncludingPrs);
  }, LIVE_TIMEOUT_MS);

  test("a failed gh call nulls its metric and records a failure", async () => {
    await requireGh();

    const result = await collectGitHubMetrics([
      `https://github.com/${FAKE_REPOSITORY}`
    ]);

    expect(result.repository?.fullName).toBe(FAKE_REPOSITORY);
    expect(result.metrics).toEqual({ S: null, I_open: null, I_closed: null });
    expect(result.missing).toEqual(["S", "I_open", "I_closed"]);
    expect(result.failures.map((failure) => failure.metric).sort()).toEqual([
      "I_closed",
      "I_open",
      "S"
    ]);
    expect(
      result.failures.every((failure) => failure.repository === FAKE_REPOSITORY)
    ).toBe(true);
  }, LIVE_TIMEOUT_MS);
});

describe("search throttling", () => {
  // The live rate-limit path is not exercised: deliberately exhausting GitHub's
  // 30 requests/minute search limit would make the suite slow and flaky. The
  // queue and retry loop are unit-tested with an injected clock and sleep.

  test("serializes calls and keeps the minimum gap", async () => {
    let now = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const throttle = new SearchThrottle({
      minGapMs: 100,
      maxRetries: 0,
      fallbackDelayMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      }
    });

    const results = await Promise.all(
      ["a", "b", "c"].map((value) =>
        throttle.run(async () => {
          starts.push(now);
          return value;
        })
      )
    );

    expect(results).toEqual(["a", "b", "c"]);
    expect(starts).toEqual([100, 200, 300]);
    expect(sleeps).toEqual([100, 100, 100]);
  });

  test("retries rate-limit errors and then succeeds", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const throttle = new SearchThrottle({
      minGapMs: 0,
      maxRetries: 3,
      fallbackDelayMs: 5_000,
      now: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      }
    });

    const value = await throttle.run(async () => {
      attempts++;
      if (attempts < 3) throw new Error("gh: API rate limit exceeded (HTTP 403)");
      return 7;
    });

    expect(value).toBe(7);
    expect(attempts).toBe(3);
    expect(delays).toEqual([5_000, 5_000]);
  });

  test("honours Retry-After when the error includes it", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const throttle = new SearchThrottle({
      minGapMs: 0,
      maxRetries: 1,
      fallbackDelayMs: 65_000,
      now: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      }
    });

    await throttle.run(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("gh: API rate limit exceeded. Retry-After: 7");
      }
      return attempts;
    });

    expect(attempts).toBe(2);
    expect(delays).toEqual([7_000]);
  });

  test("stops after the retry budget is exhausted", async () => {
    let attempts = 0;
    const throttle = new SearchThrottle({
      minGapMs: 0,
      maxRetries: 3,
      fallbackDelayMs: 1,
      now: () => 0,
      sleep: async () => {}
    });

    await expect(
      throttle.run(async () => {
        attempts++;
        throw new Error("gh: API rate limit exceeded (HTTP 403)");
      })
    ).rejects.toThrow("API rate limit exceeded");
    expect(attempts).toBe(4);
  });

  test("does not retry non-rate-limit failures", async () => {
    let attempts = 0;
    const throttle = new SearchThrottle({
      minGapMs: 0,
      maxRetries: 3,
      fallbackDelayMs: 1,
      now: () => 0,
      sleep: async () => {}
    });

    await expect(
      throttle.run(async () => {
        attempts++;
        throw new Error("gh: Not Found (HTTP 404)");
      })
    ).rejects.toThrow("HTTP 404");
    expect(attempts).toBe(1);
  });
});

describe("repository URL parsing", () => {
  test("picks the first github.com URL and drops deep paths and query strings", () => {
    const parsed = parseGitHubRepository([
      "https://gitlab.com/owner/repo",
      "https://github.com/owner/repo/tree/main/src?tab=readme#install",
      "https://github.com/other/repo"
    ]);

    expect(parsed).toEqual({
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
      url: "https://github.com/owner/repo"
    });
  });

  test("strips a trailing slash and a .git suffix", () => {
    expect(parseGitHubRepository(["https://github.com/Owner/My.Repo.git/"])).toEqual({
      owner: "Owner",
      repo: "My.Repo",
      fullName: "Owner/My.Repo",
      url: "https://github.com/Owner/My.Repo"
    });
  });

  test("accepts www.github.com and http URLs", () => {
    expect(parseGitHubRepository(["http://www.github.com/owner/repo"])?.fullName).toBe(
      "owner/repo"
    );
  });

  test("ignores non-GitHub hosts, owner-only URLs, and malformed URLs", () => {
    expect(
      parseGitHubRepository([
        "https://gitlab.com/owner/repo",
        "https://github.com/owner",
        "not a url",
        "https://bitbucket.org/owner/repo"
      ])
    ).toBeNull();
  });

  test("returns null when there are no repository URLs", () => {
    expect(parseGitHubRepository([])).toBeNull();
  });

  test("rejects reserved GitHub paths and moves on to the next candidate", () => {
    const reserved = [
      "orgs/acme",
      "topics/bioinformatics",
      "users/octocat",
      "sponsors/octocat",
      "settings/profile",
      "marketplace/actions",
      "collections/awesome",
      "explore/trending",
      "login/oauth",
      "features/actions",
      "about/careers",
      "pricing/plans",
      "apps/cli"
    ];

    for (const path of reserved) {
      expect(parseGitHubUrl(`https://github.com/${path}`)).toBeNull();
    }

    expect(
      parseGitHubRepository([
        ...reserved.map((path) => `https://github.com/${path}`),
        "https://github.com/owner/repo"
      ])?.fullName
    ).toBe("owner/repo");
  });
});

describe("GitHub metric merging", () => {
  const existingMetrics = {
    A_first: 2,
    A_senior: 3,
    A_lead: 5,
    A_total: 14,
    R: 2,
    h_lead: 17.5
  };

  const github: GitHubResult = {
    repository: {
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
      url: "https://github.com/owner/repo"
    },
    metrics: { S: 12, I_open: 1, I_closed: 4 },
    missing: [],
    failures: []
  };

  test("preserves A_*, R, and h_lead while adding S, I_open, and I_closed", () => {
    const merged = mergeGitHubMetrics(existingMetrics, github);

    expect(merged.metrics).toEqual({
      ...existingMetrics,
      S: 12,
      I_open: 1,
      I_closed: 4
    });
    expect(merged.missing).toEqual([]);
  });

  test("deduplicates missing keys from earlier stages", () => {
    const merged = mergeGitHubMetrics(
      existingMetrics,
      {
        ...github,
        metrics: { S: null, I_open: null, I_closed: null },
        missing: ["S", "I_open", "I_closed"]
      },
      ["S", "h_lead"]
    );

    expect(merged.metrics.S).toBeNull();
    expect(merged.metrics.A_total).toBe(14);
    expect(merged.missing).toEqual(["S", "h_lead", "I_open", "I_closed"]);
  });

  test("a paper without a GitHub repository gets three missing keys", async () => {
    const result = await collectGitHubMetrics(["https://gitlab.com/owner/repo"]);

    expect(result).toEqual({
      repository: null,
      metrics: { S: null, I_open: null, I_closed: null },
      missing: ["S", "I_open", "I_closed"],
      failures: []
    });
  });
});
