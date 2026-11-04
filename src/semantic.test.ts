import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSemanticAnnotations } from "./semantic";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("semantic annotations", () => {
  test("a missing file means no annotations", async () => {
    expect(await loadSemanticAnnotations("/tmp/does-not-exist-papers.json")).toEqual(
      new Map()
    );
  });

  test("loads DOI-keyed M/T annotations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ismb-semantic-"));
    dirs.push(dir);
    const path = join(dir, "papers.json");
    await Bun.write(
      path,
      JSON.stringify({
        "10.1/A": { M: true, T: "Protein structure" },
        "10.1/b": { M: false, T: "Benchmarks" }
      })
    );

    expect(await loadSemanticAnnotations(path)).toEqual(
      new Map([
        ["10.1/a", { M: true, T: "Protein structure" }],
        ["10.1/b", { M: false, T: "Benchmarks" }]
      ])
    );
  });
});
