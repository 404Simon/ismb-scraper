import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorExtractionScript,
  buildAuthorMetadata,
  type AuthorMetadata,
  type RawAuthorData
} from "./authors";
import { readReadyPage } from "./page-readiness";
import { extractPdfFirstPageText } from "./pdf";

const CHROME_VERSION_URL = "http://127.0.0.1:9222/json/version";
const LIVE_TIMEOUT_MS = 180_000;

let webSocketUrl: Promise<string> | null = null;

function chromeWebSocketUrl(): Promise<string> {
  webSocketUrl ??= (async () => {
    let response: Response;
    try {
      response = await fetch(CHROME_VERSION_URL);
    } catch (error) {
      throw new Error(
        `Chrome is not reachable at ${CHROME_VERSION_URL}. ` +
        `Start Chrome with --remote-debugging-port=9222 and a non-default --user-data-dir. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      throw new Error(`Chrome debugging endpoint returned HTTP ${response.status}: ${CHROME_VERSION_URL}`);
    }
    const info = (await response.json()) as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) {
      throw new Error(`Chrome debugging endpoint did not expose webSocketDebuggerUrl: ${CHROME_VERSION_URL}`);
    }
    return info.webSocketDebuggerUrl;
  })();
  return webSocketUrl;
}

async function liveAuthorMetadata(
  url: string,
  options: { withPdf?: boolean } = {}
): Promise<AuthorMetadata> {
  const view = new Bun.WebView({
    backend: { type: "chrome", url: await chromeWebSocketUrl() },
    width: 1440,
    height: 1200
  });

  try {
    const raw = await readReadyPage(view, url, "article", async () => {
      const data = (await view.evaluate(authorExtractionScript())) as RawAuthorData;
      if (!data || !Array.isArray(data.authors) || data.authors.length === 0) {
        throw new Error(`No OUP author block found at ${url}; the page may still be loading`);
      }
      return data;
    }, {
      interactive: true,
      timeoutMs: LIVE_TIMEOUT_MS,
      retries: 2,
      stableMs: 2000
    });

    const firstPageText = options.withPdf
      ? await pdfFirstPageTextFromView(view, url)
      : null;

    return buildAuthorMetadata(
      raw,
      [],
      firstPageText ? { firstPageText: async () => firstPageText } : {}
    );
  } finally {
    view.close();
  }
}

async function pdfFirstPageTextFromView(
  view: Bun.WebView,
  articleUrl: string
): Promise<string> {
  const pdfUrl = String(await view.evaluate(
    `document.querySelector('meta[name="citation_pdf_url" i]')?.getAttribute("content") || ""`
  ));
  if (!pdfUrl) throw new Error(`No citation_pdf_url on ${articleUrl}`);

  const frameTree = (await view.cdp("Page.getFrameTree")) as any;
  const frameId = frameTree?.frameTree?.frame?.id;
  if (!frameId) throw new Error(`Could not determine Chrome frame id for ${articleUrl}`);

  const loaded = (await view.cdp("Network.loadNetworkResource", {
    frameId,
    url: pdfUrl,
    options: { disableCache: false, includeCredentials: true }
  })) as any;
  const resource = loaded?.resource;
  if (!resource?.success || !resource?.stream) {
    throw new Error(
      `Could not download ${pdfUrl} (HTTP ${resource?.httpStatusCode ?? "?"})`
    );
  }

  const chunks: Uint8Array[] = [];
  while (true) {
    const part = (await view.cdp("IO.read", {
      handle: resource.stream,
      size: 1024 * 1024
    })) as any;
    chunks.push(part?.base64Encoded
      ? Buffer.from(part.data || "", "base64")
      : Buffer.from(part?.data || "", "utf8"));
    if (part?.eof) break;
  }
  try {
    await view.cdp("IO.close", { handle: resource.stream });
  } catch {}

  const path = join(tmpdir(), `ismb-pdf-${crypto.randomUUID()}.pdf`);
  await Bun.write(path, Buffer.concat(chunks));
  try {
    const text = await extractPdfFirstPageText(path);
    if (!text) throw new Error(`pdftotext could not read ${pdfUrl}`);
    return text;
  } finally {
    await rm(path, { force: true });
  }
}

describe("live OUP author metadata", () => {
  test("btae212 combines named joint first and jointly supervised authors", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/40/Supplement_1/i247/7702909"
    );

    expect(meta.authors_detail).toHaveLength(9);
    expect(meta.joint_first).toEqual(["Xinrui Lyu", "Bowen Fan", "Matthias Hüser"]);
    expect(meta.joint_senior).toEqual(["Gunnar Rätsch", "Karsten Borgwardt"]);
    expect(meta.metrics).toEqual({ A_first: 3, A_senior: 2, A_lead: 5, A_total: 9 });
    expect(meta.author_notes).toHaveLength(2);
    expect(meta.author_notes.some((note) => /joint first authors/i.test(note))).toBe(true);
    expect(meta.authors_detail[0].orcid).toMatch(/^https:\/\/orcid\.org\//);
  }, LIVE_TIMEOUT_MS);

  test("btag326 reads a named joint first author designation", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/42/Supplement_1/btag326/8364567"
    );

    expect(meta.joint_first).toEqual(["Sakina Amin", "Lauren Overend"]);
    expect(meta.joint_senior).toEqual(["Rachael Bashford-Rogers"]);
    expect(meta.metrics).toEqual({ A_first: 2, A_senior: 1, A_lead: 3, A_total: 8 });
  }, LIVE_TIMEOUT_MS);

  test("btag278 reads joint lead and joint senior designations", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/42/Supplement_1/btag278/8364543"
    );

    expect(meta.joint_first).toEqual(["Arya Pradeep Menon", "Trenton Davis"]);
    expect(meta.joint_senior).toEqual(["Lonnie R Welch", "Alastair M Kilpatrick", "Farzana Rahman"]);
    expect(meta.metrics).toEqual({ A_first: 2, A_senior: 3, A_lead: 5, A_total: 14 });
  }, LIVE_TIMEOUT_MS);

  test("btae232 resolves an unnamed ordinal joint first note", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/40/Supplement_1/i418/7702904"
    );

    expect(meta.joint_first).toEqual(["Guanglei Yu", "Qichang Zhao"]);
    expect(meta.joint_senior).toEqual(["Jianxin Wang"]);
    expect(meta.metrics).toEqual({ A_first: 2, A_senior: 1, A_lead: 3, A_total: 4 });
    expect(meta.author_notes.some((note) => /first two authors/i.test(note))).toBe(true);
  }, LIVE_TIMEOUT_MS);

  test("btaf216 reads a named joint senior designation", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/41/Supplement_1/i12/8199389"
    );

    expect(meta.joint_first).toEqual(["Nelly Sélem-Mojica"]);
    expect(meta.joint_senior).toEqual(["Lonnie R Welch", "Alastair M Kilpatrick", "Farzana Rahman"]);
    expect(meta.metrics).toEqual({ A_first: 1, A_senior: 3, A_lead: 4, A_total: 18 });
  }, LIVE_TIMEOUT_MS);

  test("btae252 reads equal contribution and joint supervision notes", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/40/Supplement_1/i30/7700908"
    );

    expect(meta.joint_first).toEqual(["Jim Shaw", "Jean-Sebastien Gounot"]);
    expect(meta.joint_senior).toEqual(["Niranjan Nagarajan", "Yun William Yu"]);
    expect(meta.metrics).toEqual({ A_first: 2, A_senior: 2, A_lead: 4, A_total: 5 });
  }, LIVE_TIMEOUT_MS);

  test("btae242 ignores equal contribution as second authors", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/40/Supplement_1/i548/7700863"
    );

    expect(meta.joint_first).toEqual(["Mayar Ali", "Merel Kuijs"]);
    expect(meta.joint_senior).toEqual(["Fabian J Theis"]);
    expect(meta.metrics).toEqual({ A_first: 2, A_senior: 1, A_lead: 3, A_total: 8 });
  }, LIVE_TIMEOUT_MS);

  test("btae216 keeps a consortium author once", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/40/Supplement_1/i189/7700877"
    );

    expect(meta.metrics.A_total).toBe(12);
    expect(meta.has_group_author).toBe(true);
    expect(meta.authors_detail.filter((author) => author.name === "The Tumor Profiler Consortium")).toHaveLength(1);
    expect(meta.joint_first).toEqual(["Alexander Immer"]);
    expect(meta.joint_senior).toEqual(["Kjong-Van Lehmann"]);
  }, LIVE_TIMEOUT_MS);

  test("btag214 scopes author notes to the author block", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/42/Supplement_1/btag214/8726338"
    );

    expect(meta.author_notes).toHaveLength(1);
    expect(meta.author_notes[0]).toMatch(/contributed equally/);
    expect(meta.joint_first).toEqual(["Zhizheng Wang", "Chi-Ping Day"]);
    expect(meta.metrics.A_total).toBe(12);
  }, LIVE_TIMEOUT_MS);

  test("btae227 resolves an unnamed equal-contribution note from the PDF", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/40/Supplement_1/i68/7700851",
      { withPdf: true }
    );

    expect(meta.author_notes).toEqual(["Equal contribution."]);
    expect(meta.joint_first).toEqual(["Ziyi Huang", "Dehan Cai"]);
    expect(meta.joint_senior).toEqual(["Yanni Sun"]);
    expect(meta.joint_source).toBe("pdf");
    expect(meta.metrics).toEqual({ A_first: 2, A_senior: 1, A_lead: 3, A_total: 3 });
  }, LIVE_TIMEOUT_MS);

  test("btag274 resolves an unnamed equal-contribution note from the PDF", async () => {
    const meta = await liveAuthorMetadata(
      "https://academic.oup.com/bioinformatics/article/42/Supplement_1/btag274/8726288",
      { withPdf: true }
    );

    expect(meta.author_notes).toEqual(["equal contribution."]);
    expect(meta.joint_first).toEqual(["Gihyeon Kim", "Seungyeon Rhee", "Yumi Lee"]);
    expect(meta.joint_senior).toEqual(["Jang-Hwan Choi"]);
    expect(meta.joint_source).toBe("pdf");
    expect(meta.metrics).toEqual({ A_first: 3, A_senior: 1, A_lead: 4, A_total: 6 });
  }, LIVE_TIMEOUT_MS);
});
