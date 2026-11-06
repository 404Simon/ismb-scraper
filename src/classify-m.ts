#!/usr/bin/env bun

/**
 * Classify every archived ISMB paper as method-focused (`M: true`) or not
 * (`M: false`) and write the result into `metadata/*.json`, `papers.json`, and
 * `papers.csv`.
 *
 * No embeddings or cluster exports are involved:
 *
 *   bun run classify-m
 *
 * Papers that already have a boolean `M` are reused. Rerun the same command to
 * retry failures.
 */

import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { toCsv, type CsvRecord } from "./metadata";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = join(ROOT, "output");
const PROMPT_PATH = join(ROOT, "semantic", "prompts", "classify_method.md");

const MODEL = "opencode-go/deepseek-v4.1-flash";
const AGENT = "semantic-classifier";
const TIMEOUT_MS = 300_000;
const MAX_PAPER_CHARS = 6_000;
const MIN_PAPER_CHARS = 1_000;

export interface PaperRecord extends CsvRecord {
  metrics: CsvRecord["metrics"] & { M?: boolean | null };
  metrics_meta: { missing: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

export async function extractArticleText(htmlPath: string): Promise<string> {
  const html = await Bun.file(htmlPath).text();
  const article = normalizeText(await collectText(html, "div.article-body"));
  if (article.length >= MIN_PAPER_CHARS) return article;
  return normalizeText(await collectText(html, "body"));
}

export function parseMethodOutput(stdout: string): boolean | null {
  const fromEvents = parseEventText(stdout);
  return methodFromText(fromEvents || stdout);
}

export function methodFromText(text: string): boolean | null {
  const cleaned = text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
    .replace(/<\/?think[^>]*>/gi, "")
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/\s*```/g, "");

  const values: boolean[] = [];
  for (const value of jsonObjects(cleaned)) {
    if (value === null || typeof value !== "object") continue;
    const method = (value as Record<string, unknown>).M ?? (value as Record<string, unknown>).m;
    if (typeof method === "boolean") values.push(method);
    else if (typeof method === "string" && /^(true|false)$/i.test(method)) {
      values.push(method.toLowerCase() === "true");
    }
  }
  return values.length > 0 ? values[values.length - 1] : null;
}

/** Update `metrics.M` and keep `metrics_meta.missing` consistent. */
export function setMethod(record: PaperRecord, method: boolean | null): boolean {
  const before = JSON.stringify(record);
  record.metrics.M = method;
  syncMissing(record);
  return JSON.stringify(record) !== before;
}

export function syncMissing(record: PaperRecord): boolean {
  const before = JSON.stringify(record);
  const missing = Array.isArray(record.metrics_meta?.missing)
    ? [...record.metrics_meta.missing]
    : [];
  const names = new Set(missing);
  if (typeof record.metrics.M === "boolean") names.delete("M");
  else names.add("M");
  record.metrics_meta = { ...(record.metrics_meta ?? {}), missing: [...names] };
  return JSON.stringify(record) !== before;
}

async function main(): Promise<void> {
  const template = await Bun.file(PROMPT_PATH).text();
  const issues = (await readdir(OUTPUT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^ismb-\d{4}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (issues.length === 0) {
    throw new Error(`No ismb-* directories found under ${OUTPUT}`);
  }

  let classified = 0;
  let reused = 0;
  let failed = 0;

  for (const issue of issues) {
    const metadataDir = join(OUTPUT, issue, "metadata");
    const files = (await readdir(metadataDir))
      .filter((name) => name.endsWith(".json") && name !== "papers.json" && name !== "errors.json")
      .sort();

    const records: PaperRecord[] = [];
    for (const file of files) {
      const metadataPath = join(metadataDir, file);
      let record: PaperRecord;
      try {
        record = (await Bun.file(metadataPath).json()) as PaperRecord;
      } catch (error) {
        failed += 1;
        console.error(`[M] ${issue}/${file}: FAILED (${messageOf(error)})`);
        continue;
      }
      records.push(record);

      const paperId = file.slice(0, -".json".length);
      const label = `${issue}/${paperId}`;

      if (typeof record.metrics?.M === "boolean") {
        if (syncMissing(record)) await writeRecord(metadataPath, record);
        reused += 1;
        console.log(`[M] ${label}: ${record.metrics.M} (reused)`);
        continue;
      }

      const articlePath = join(OUTPUT, issue, "files", paperId, "article.html");
      if (!(await Bun.file(articlePath).exists())) {
        if (setMethod(record, null)) await writeRecord(metadataPath, record);
        failed += 1;
        console.error(`[M] ${label}: FAILED (missing ${relative(ROOT, articlePath)})`);
        continue;
      }

      try {
        const text = await extractArticleText(articlePath);
        if (text.length < MIN_PAPER_CHARS) {
          throw new Error(`article text too short (${text.length} chars)`);
        }

        const prompt = buildPrompt(template, String(record.paper_name ?? ""), text);
        const method = parseMethodOutput(await runOpenCode(prompt));
        if (method === null) throw new Error("malformed method output");

        setMethod(record, method);
        await writeRecord(metadataPath, record);
        classified += 1;
        console.log(`[M] ${label}: ${method}`);
      } catch (error) {
        if (setMethod(record, null)) await writeRecord(metadataPath, record);
        failed += 1;
        console.error(`[M] ${label}: FAILED (${messageOf(error)})`);
      }
    }

    await writeAggregates(metadataDir, records);
  }

  console.log(`\nM: ${classified} classified, ${reused} reused, ${failed} failed`);
  if (failed > 0) process.exitCode = 3;
}

async function runOpenCode(prompt: string): Promise<string> {
  const process = Bun.spawn(
    ["opencode", "run", "-m", MODEL, "--agent", AGENT, "--format", "json", prompt],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }
  );

  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);

  if (code !== 0) {
    const detail = (stderr || stdout).trim().split("\n").filter(Boolean);
    throw new Error(`opencode exited ${code}: ${detail.at(-1) ?? "no output"}`);
  }
  return stdout;
}

function buildPrompt(template: string, title: string, text: string): string {
  return template
    .replace("$title", () => title)
    .replace("$text", () => text.slice(0, MAX_PAPER_CHARS));
}

function parseEventText(stdout: string): string {
  let text = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (
        event?.type === "text" &&
        event.part?.type === "text" &&
        typeof event.part.text === "string"
      ) {
        text += event.part.text;
      }
    } catch {
      // Ignore non-JSON lines from the event stream.
    }
  }
  return text;
}

function jsonObjects(text: string): unknown[] {
  const values: unknown[] = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            values.push(JSON.parse(text.slice(start, index + 1)));
          } catch {
            // Not valid JSON; keep scanning.
          }
          break;
        }
      }
    }
  }
  return values;
}

async function collectText(html: string, selector: string): Promise<string> {
  let text = "";
  const rewriter = new HTMLRewriter().on(selector, {
    text(chunk) {
      text += chunk.text;
    }
  });
  await rewriter.transform(new Response(html)).text();
  return text;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function writeRecord(path: string, record: PaperRecord): Promise<void> {
  await Bun.write(path, JSON.stringify(record, null, 2) + "\n");
}

async function writeAggregates(metadataDir: string, records: PaperRecord[]): Promise<void> {
  const papersPath = join(metadataDir, "papers.json");
  let ordered = records;

  if (await Bun.file(papersPath).exists()) {
    try {
      const existing = (await Bun.file(papersPath).json()) as unknown;
      if (Array.isArray(existing)) {
        const byKey = new Map(records.map((record) => [recordKey(record), record]));
        const used = new Set<PaperRecord>();
        ordered = existing.map((value) => {
          const updated = byKey.get(recordKey(value as PaperRecord));
          if (!updated) return value as PaperRecord;
          used.add(updated);
          return updated;
        });
        for (const record of records) {
          if (!used.has(record)) ordered.push(record);
        }
      }
    } catch {
      // Fall back to the per-paper records in file order.
    }
  }

  await Bun.write(papersPath, JSON.stringify(ordered, null, 2) + "\n");
  await Bun.write(join(metadataDir, "papers.csv"), toCsv(ordered));
}

function recordKey(record: PaperRecord): string {
  const doi = String(record.doi ?? "").trim().toLowerCase();
  return doi ? `doi:${doi}` : `name:${String(record.paper_name ?? "").trim()}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  await main();
}
