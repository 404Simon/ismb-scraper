import { describe, expect, test } from "bun:test";
import type { AuthorDetail } from "./authors";
import { computeLeadLabs, minimumHittingSet } from "./affiliations";

function author(name: string, affiliations: string[]): AuthorDetail {
  return { name, affiliations, country_hints: [], orcid: null };
}

describe("minimum hitting set", () => {
  test("picks the shared affiliation", () => {
    expect(
      minimumHittingSet([
        ["Lab A", "Lab B"],
        ["Lab B", "Lab C"]
      ])
    ).toEqual(["Lab B"]);
  });

  test("returns a minimum set when no single affiliation hits everything", () => {
    const hittingSet = minimumHittingSet([
      ["Lab A", "Lab B"],
      ["Lab C", "Lab D"],
      ["Lab A", "Lab C"]
    ]);

    expect(hittingSet).toHaveLength(2);
    expect(new Set(hittingSet)).toEqual(new Set(["Lab A", "Lab C"]));
  });

  test("normalizes case, whitespace, and trailing punctuation", () => {
    expect(
      minimumHittingSet([
        [" Lab A, University. "],
        ["lab a, university"]
      ])
    ).toEqual(["Lab A, University"]);
  });

  test("drops a redundant superset", () => {
    expect(minimumHittingSet([["Lab A"], ["Lab A", "Lab B"]])).toEqual([
      "Lab A"
    ]);
  });

  test("returns an empty set when there are no constraints", () => {
    expect(minimumHittingSet([])).toEqual([]);
    expect(minimumHittingSet([[], []])).toEqual([]);
  });
});

describe("lead labs", () => {
  test("counts a shared lab and its country", () => {
    const result = computeLeadLabs(
      [
        author("First Author", [
          "Lab A, Zurich, Switzerland",
          "Lab B, Basel, Switzerland"
        ]),
        author("Senior Author", [
          "Lab B, Basel, Switzerland",
          "Lab C, Geneva, Switzerland"
        ])
      ],
      ["First Author"],
      ["Senior Author"]
    );

    expect(result).toEqual({
      count: 1,
      countries: ["Switzerland"],
      affiliations: ["Lab B, Basel, Switzerland"]
    });
  });

  test("counts distinct labs and countries", () => {
    const result = computeLeadLabs(
      [
        author("First Author", ["Lab A, Zurich, Switzerland"]),
        author("Senior Author", ["Lab B, Boston, MA, USA"])
      ],
      ["First Author"],
      ["Senior Author"]
    );

    expect(result).toEqual({
      count: 2,
      countries: ["Switzerland", "United States"],
      affiliations: ["Lab A, Zurich, Switzerland", "Lab B, Boston, MA, USA"]
    });
  });

  test("ignores lead authors without an affiliation", () => {
    const result = computeLeadLabs(
      [
        author("First Author", ["Lab A, Zurich, Switzerland"]),
        author("The Consortium", [])
      ],
      ["First Author"],
      ["The Consortium"]
    );

    expect(result).toEqual({
      count: 1,
      countries: ["Switzerland"],
      affiliations: ["Lab A, Zurich, Switzerland"]
    });
  });

  test("returns null when no lead author has an affiliation", () => {
    const result = computeLeadLabs(
      [author("First Author", []), author("Senior Author", [])],
      ["First Author"],
      ["Senior Author"]
    );

    expect(result).toEqual({ count: null, countries: null, affiliations: null });
  });

  test("returns null countries when a selected affiliation has no country", () => {
    const result = computeLeadLabs(
      [author("First Author", ["Lab A"]), author("Senior Author", ["Lab B"])],
      ["First Author"],
      ["Senior Author"]
    );

    expect(result).toEqual({
      count: 2,
      countries: null,
      affiliations: ["Lab A", "Lab B"]
    });
  });
});
