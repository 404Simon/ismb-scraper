import { describe, expect, test } from "bun:test";
import {
  methodFromText,
  parseMethodOutput,
  setMethod,
  syncMissing,
  type PaperRecord
} from "./classify-m";

function record(missing = ["M", "T"], method: boolean | null = null): PaperRecord {
  return {
    paper_name: "Paper",
    authors: [],
    joint_first: [],
    joint_senior: [],
    lead_affiliations: null,
    openalex_senior_authors: [],
    metrics: { M: method },
    doi: "10.1/x",
    article_url: "",
    link_to_pdf: "",
    artifacts: {
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
    },
    files: { html: null, pdf: null, figures: [] },
    metrics_meta: { missing }
  };
}

describe("method parsing", () => {
  test("reads a strict JSON answer", () => {
    expect(methodFromText('{"M": true}')).toBe(true);
    expect(methodFromText('{"M": false}')).toBe(false);
    expect(methodFromText('{"m": "true"}')).toBe(true);
  });

  test("ignores prose, think blocks, and fences", () => {
    expect(methodFromText('Result: {"M": true}')).toBe(true);
    expect(methodFromText('</think>\n```json\n{"M": false}\n```')).toBe(false);
  });

  test("uses the last valid answer", () => {
    expect(methodFromText('{"M": false} then {"M": true}')).toBe(true);
  });

  test("rejects unknown values", () => {
    expect(methodFromText('{"M": "maybe"}')).toBeNull();
    expect(methodFromText("no json")).toBeNull();
  });

  test("reads the OpenCode event stream", () => {
    const stdout = JSON.stringify({
      type: "text",
      part: { type: "text", text: '{"M": true}' }
    });
    expect(parseMethodOutput(stdout)).toBe(true);
  });
});

describe("metadata update", () => {
  test("sets M and removes it from missing", () => {
    const paper = record();
    expect(setMethod(paper, true)).toBe(true);
    expect(paper.metrics.M).toBe(true);
    expect(paper.metrics_meta.missing).toEqual(["T"]);
  });

  test("clears M and adds it to missing", () => {
    const paper = record(["T"], true);
    expect(setMethod(paper, null)).toBe(true);
    expect(paper.metrics.M).toBeNull();
    expect(paper.metrics_meta.missing).toEqual(["T", "M"]);
  });

  test("does not rewrite an unchanged record", () => {
    const paper = record(["M", "T"], null);
    expect(syncMissing(paper)).toBe(false);
  });
});
