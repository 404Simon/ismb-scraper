import { describe, expect, test } from "bun:test";
import type { AuthorDetail, AuthorMetrics } from "./authors";
import {
  collectOpenAlexMetrics,
  fetchAuthorHIndexes,
  fetchOpenAlexWork,
  mergePaperMetrics,
  resolveSeniorAuthorIds,
  type OpenAlexAuthorship,
  type OpenAlexWork
} from "./openalex";

const LIVE_TIMEOUT_MS = 60_000;
const BTAF216_SENIORS = ["Lonnie R Welch", "Alastair M Kilpatrick", "Farzana Rahman"];
const BTAE247_SENIORS = ["Alastair M Kilpatrick", "Lonnie R Welch", "Farzana Rahman"];

function detail(name: string, orcid: string | null = null): AuthorDetail {
  return { name, affiliations: [], country_hints: [], orcid };
}

function work(authorships: OpenAlexAuthorship[], citedByCount = 3): OpenAlexWork {
  return {
    citedByCount,
    authorships
  };
}

describe("live OpenAlex metrics", () => {
  test("btaf216 resolves a cited-by count and the three senior h-indexes", async () => {
    const result = await collectOpenAlexMetrics({
      doi: "10.1093/bioinformatics/btaf216",
      jointSenior: BTAF216_SENIORS,
      authorsDetail: BTAF216_SENIORS.map((name) => detail(name))
    });

    expect(Number.isInteger(result.metrics.R)).toBe(true);
    expect(result.metrics.R as number).toBeGreaterThanOrEqual(0);
    expect(typeof result.metrics.h_lead).toBe("number");
    expect(result.metrics.h_lead as number).toBeGreaterThan(0);
    expect(result.missing).not.toContain("h_lead");
    expect(result.missing).not.toContain("R");
  }, LIVE_TIMEOUT_MS);

  test("btae247 resolves all three real joint senior authors", async () => {
    const resolvedWork = await fetchOpenAlexWork("10.1093/bioinformatics/btae247");
    expect(resolvedWork).not.toBeNull();

    const authorsDetail = BTAE247_SENIORS.map((name) => detail(name));
    const resolved = resolveSeniorAuthorIds(
      BTAE247_SENIORS,
      resolvedWork!,
      authorsDetail
    );
    expect(resolved.unresolved).toEqual([]);
    expect(new Set(resolved.authorIds).size).toBe(3);

    const hIndexes = await fetchAuthorHIndexes(resolved.authorIds);
    const values = resolved.authorIds.map((id) => hIndexes.get(id));
    expect(values.every((value) => typeof value === "number")).toBe(true);
    const expectedMean =
      values.reduce((sum, value) => sum + (value ?? 0), 0) /
      resolved.authorIds.length;

    const result = await collectOpenAlexMetrics({
      doi: "10.1093/bioinformatics/btae247",
      jointSenior: BTAE247_SENIORS,
      authorsDetail
    });

    expect(result.metrics.h_lead as number).toBeGreaterThan(0);
    expect(Math.abs((result.metrics.h_lead as number) - expectedMean)).toBeLessThan(1);
    expect(result.missing).not.toContain("h_lead");
  }, LIVE_TIMEOUT_MS);

  test("a single selected senior author resolves to one h-index", async () => {
    const result = await collectOpenAlexMetrics({
      doi: "10.1093/bioinformatics/btae247",
      jointSenior: ["Farzana Rahman"],
      authorsDetail: [detail("Farzana Rahman")]
    });

    expect(result.metrics.h_lead as number).toBeGreaterThan(0);
    expect(result.missing).not.toContain("h_lead");
  }, LIVE_TIMEOUT_MS);

  test("a mixed resolution refuses to compute a partial mean", async () => {
    const result = await collectOpenAlexMetrics({
      doi: "10.1093/bioinformatics/btae247",
      jointSenior: ["Farzana Rahman", "Not An Author On This Paper"],
      authorsDetail: [detail("Farzana Rahman")]
    });

    expect(result.metrics.R as number).toBeGreaterThanOrEqual(0);
    expect(result.metrics.h_lead).toBeNull();
    expect(result.missing).toContain("h_lead");
  }, LIVE_TIMEOUT_MS);

  test("an unmatched senior name nulls h_lead and records it as missing", async () => {
    const result = await collectOpenAlexMetrics({
      doi: "10.1093/bioinformatics/btaf216",
      jointSenior: ["Not An Author On This Paper"],
      authorsDetail: []
    });

    expect(result.metrics.R as number).toBeGreaterThanOrEqual(0);
    expect(result.metrics.h_lead).toBeNull();
    expect(result.missing).toContain("h_lead");
  }, LIVE_TIMEOUT_MS);

  test("an unknown DOI nulls R and h_lead", async () => {
    const result = await collectOpenAlexMetrics({
      doi: "10.1093/bioinformatics/does-not-exist-xyz",
      jointSenior: BTAF216_SENIORS,
      authorsDetail: []
    });

    expect(result.metrics).toEqual({ R: null, h_lead: null });
    expect(result.missing).toEqual(["R", "h_lead"]);
  }, LIVE_TIMEOUT_MS);

  test("the work endpoint exposes authorships for the DOI", async () => {
    const resolved = await fetchOpenAlexWork("10.1093/bioinformatics/btaf216");
    expect(resolved).not.toBeNull();
    expect(resolved?.authorships.length).toBeGreaterThan(3);
    expect(resolved?.authorships.some((authorship) => authorship.name === "Lonnie R Welch")).toBe(true);
  }, LIVE_TIMEOUT_MS);

  test("author h-indexes can be fetched in one batch", async () => {
    const hIndexes = await fetchAuthorHIndexes([
      "https://openalex.org/A5069844269",
      "https://openalex.org/A5004851534"
    ]);

    expect(hIndexes.get("https://openalex.org/A5069844269")).toBeGreaterThan(0);
    expect(hIndexes.get("https://openalex.org/A5004851534")).toBeGreaterThan(0);
  }, LIVE_TIMEOUT_MS);
});

describe("senior author resolution", () => {
  test("matches a normalized exact name before falling back to ORCID", () => {
    const resolved = resolveSeniorAuthorIds(
      ["José Álvarez"],
      work([{ authorId: "https://openalex.org/A1", name: "Jose Alvarez", displayName: "José Álvarez", orcid: null }]),
      [detail("José Álvarez", "https://orcid.org/0000-0000-0000-0001")]
    );

    expect(resolved).toEqual({ authorIds: ["https://openalex.org/A1"], unresolved: [] });
  });

  test("falls back to the ORCID when names differ", () => {
    const resolved = resolveSeniorAuthorIds(
      ["Alastair M Kilpatrick"],
      work([{
        authorId: "https://openalex.org/A2",
        name: "A. M. Kilpatrick",
        displayName: "Alastair Kilpatrick",
        orcid: "https://orcid.org/0000-0002-4795-8799"
      }]),
      [detail("Alastair M Kilpatrick", "https://orcid.org/0000-0002-4795-8799")]
    );

    expect(resolved).toEqual({ authorIds: ["https://openalex.org/A2"], unresolved: [] });
  });

  test("rejects a name that matches two different OpenAlex authors", () => {
    const resolved = resolveSeniorAuthorIds(
      ["Farzana Rahman"],
      work([
        { authorId: "https://openalex.org/A3", name: "Farzana Rahman", displayName: "Farzana Rahman", orcid: null },
        { authorId: "https://openalex.org/A4", name: "Farzana Rahman", displayName: "Farzana Rahman", orcid: null }
      ]),
      []
    );

    expect(resolved.authorIds).toEqual([]);
    expect(resolved.unresolved).toEqual(["Farzana Rahman"]);
  });

  test("ORCID disambiguates a repeated name", () => {
    const resolved = resolveSeniorAuthorIds(
      ["Farzana Rahman"],
      work([
        { authorId: "https://openalex.org/A3", name: "Farzana Rahman", displayName: "Farzana Rahman", orcid: "https://orcid.org/0000-0000-0000-0003" },
        { authorId: "https://openalex.org/A4", name: "Farzana Rahman", displayName: "Farzana Rahman", orcid: "https://orcid.org/0000-0000-0000-0004" }
      ]),
      [detail("Farzana Rahman", "https://orcid.org/0000-0000-0000-0004")]
    );

    expect(resolved).toEqual({ authorIds: ["https://openalex.org/A4"], unresolved: [] });
  });
});

describe("metric merging", () => {
  const authorMetrics: AuthorMetrics = { A_first: 2, A_senior: 3, A_lead: 5, A_total: 14 };

  test("keeps the author counts when OpenAlex values are present", () => {
    const merged = mergePaperMetrics(authorMetrics, {
      metrics: { R: 2, h_lead: 17 },
      missing: []
    });

    expect(merged.metrics).toEqual({ ...authorMetrics, R: 2, h_lead: 17 });
    expect(merged.missing).toEqual([]);
  });

  test("keeps the author counts when OpenAlex values are missing", () => {
    const merged = mergePaperMetrics(authorMetrics, {
      metrics: { R: null, h_lead: null },
      missing: ["R", "h_lead"]
    });

    expect(merged.metrics).toEqual({ ...authorMetrics, R: null, h_lead: null });
    expect(merged.missing).toEqual(["R", "h_lead"]);
  });

  test("merges and deduplicates missing values from earlier metrics", () => {
    const merged = mergePaperMetrics(
      authorMetrics,
      { metrics: { R: null, h_lead: null }, missing: ["R", "h_lead"] },
      ["S", "h_lead"]
    );

    expect(merged.missing).toEqual(["S", "h_lead", "R"]);
  });

  test("a missing DOI nulls both values without a request", async () => {
    const result = await collectOpenAlexMetrics({
      doi: "",
      jointSenior: ["Someone"],
      authorsDetail: [detail("Someone")]
    });

    expect(result).toEqual({
      metrics: { R: null, h_lead: null },
      missing: ["R", "h_lead"]
    });
  });
});
