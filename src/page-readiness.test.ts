import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { pageStateScript, readReadyPage, type PageState } from "./page-readiness";

const url = "https://academic.oup.com/bioinformatics/article/42/Supplement_1/btag303/8726350";
const ready: PageState = { url, title: "RAmpSim", challenge: false, ready: true, signature: "article-1" };
const blank: PageState = { ...ready, title: "", ready: false, signature: "blank" };
const challenge: PageState = { ...blank, title: "Just a moment...", challenge: true };

function harness(state: (time: number, navigations: number) => PageState | Error) {
  let time = 0;
  let navigations = 0;
  const logs: string[] = [];
  const view = {
    async navigate() { navigations++; },
    async evaluate() {
      const result = state(time, navigations);
      if (result instanceof Error) throw result;
      return result;
    }
  };
  const options = {
    interactive: true, timeoutMs: 10_000, stableMs: 2000, pollMs: 500,
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
    log: (line: string) => { logs.push(line); }
  };
  return { view, options, logs, time: () => time, navigations: () => navigations };
}

describe("waiting for verified content", () => {
  test("blank redirects and destroyed contexts do not clear a challenge", async () => {
    const h = harness(time => time < 1000 ? challenge : time < 2000 ? blank :
      time < 3000 ? new Error("Execution context was destroyed") : ready);
    let extractedAt = 0;
    const result = await readReadyPage(h.view, url, "article", async () => {
      extractedAt = h.time();
      return "article";
    }, h.options);
    expect(result).toBe("article");
    expect(extractedAt).toBe(5000);
    expect(h.navigations()).toBe(1);
  });

  test("a challenge returning during stabilization resets the wait", async () => {
    const h = harness(time => time < 1000 ? ready : time < 2500 ? challenge : ready);
    await readReadyPage(h.view, url, "article", async () => "ok", h.options);
    expect(h.time()).toBe(4500);
  });

  test("changing article content must stabilize before extraction", async () => {
    const h = harness(time => ({ ...ready, signature: time < 1500 ? String(time) : "final" }));
    await readReadyPage(h.view, url, "article", async () => "ok", h.options);
    expect(h.time()).toBe(3500);
  });

  test("an extraction race retries in the same tab", async () => {
    const h = harness(() => ready);
    let calls = 0;
    const result = await readReadyPage(h.view, url, "article", async () => {
      if (++calls === 1) throw new Error("Cannot read properties of null (reading 'querySelectorAll')");
      return "ok";
    }, h.options);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(h.navigations()).toBe(1);
    expect(h.time()).toBe(4500);
  });

  test("a redirect during extraction invalidates the result", async () => {
    let redirected = false;
    const h = harness(() => redirected ? { ...ready, signature: "article-2" } : ready);
    let calls = 0;
    const result = await readReadyPage(h.view, url, "issue", async () => {
      calls++;
      redirected = true;
      return calls;
    }, h.options);
    expect(result).toBe(2);
  });

  test("navigation errors still allow an ongoing challenge to finish", async () => {
    const h = harness(time => time < 1000 ? challenge : ready);
    h.view.navigate = async () => { throw new Error("Navigation timed out"); };
    expect(await readReadyPage(h.view, url, "article", async () => "ok", h.options)).toBe("ok");
  });

  test("late challenges receive the full configured timeout", async () => {
    const h = harness(time => time < 9000 ? blank : time < 15_000 ? challenge : ready);
    await readReadyPage(h.view, url, "article", async () => "ok", h.options);
    expect(h.time()).toBe(17_000);
    expect(h.navigations()).toBe(1);
  });

  test("manual challenge timeouts never reload the verification tab", async () => {
    const h = harness(() => challenge);
    await expect(readReadyPage(h.view, url, "article", async () => "wrong", h.options)).rejects.toThrow("did not become ready");
    expect(h.navigations()).toBe(1);
    expect(h.time()).toBe(10_000);
  });

  test("headless challenges fail with instructions immediately", async () => {
    const h = harness(() => challenge);
    await expect(readReadyPage(h.view, url, "article", async () => "wrong", {
      ...h.options, interactive: false
    })).rejects.toThrow("--chrome-debug-port");
    expect(h.navigations()).toBe(1);
    expect(h.time()).toBe(0);
  });

  test("stalled non-challenge pages reload with backoff", async () => {
    const h = harness((_time, navigations) => navigations === 1 ? blank : ready);
    await readReadyPage(h.view, url, "article", async () => "ok", h.options);
    expect(h.navigations()).toBe(2);
    expect(h.logs.some(line => line.includes("Retrying article page"))).toBe(true);
  });

  test("retries are bounded", async () => {
    const h = harness(() => blank);
    await expect(readReadyPage(h.view, url, "issue", async () => "wrong", h.options)).rejects.toThrow("did not become ready");
    expect(h.navigations()).toBe(3);
  });
});

describe("browser content probe", () => {
  function probe(overrides: {
    title?: string; body?: string | null; citation?: string; rootText?: string;
    location?: string; readyState?: string; challengeDom?: boolean; links?: string[];
  } = {}, kind: "article" | "issue" = "article") {
    const target = kind === "article" ? url : "https://academic.oup.com/bioinformatics/issue/42/Supplement_1";
    const root = overrides.rootText === undefined ? "Article text ".repeat(100) : overrides.rootText;
    return runInNewContext(pageStateScript(kind, target), {
      URL, location: new URL(overrides.location ?? target), performance: { timeOrigin: 123 },
      document: {
        title: overrides.title ?? "RAmpSim", readyState: overrides.readyState ?? "complete",
        body: overrides.body === null ? null : { innerText: overrides.body ?? "Article text" },
        querySelector(selector: string) {
          if (selector.includes("citation_title")) return { getAttribute: () => overrides.citation ?? "RAmpSim" };
          if (selector.startsWith("article,")) return root ? { textContent: root, querySelectorAll: () => [] } : null;
          return overrides.challengeDom ? {} : null;
        },
        querySelectorAll: () => (overrides.links ?? []).map(href => ({ href, textContent: "RAmpSim" }))
      }
    }) as PageState;
  }

  test("real content is required even with no challenge text", () => {
    expect(probe({ body: null, rootText: "", citation: "" }).ready).toBe(false);
    expect(probe({ rootText: "" }).ready).toBe(false);
    expect(probe({ citation: "" }).ready).toBe(false);
    expect(probe({ readyState: "loading" }).ready).toBe(false);
    expect(probe().ready).toBe(true);
  });

  test("wrong URLs and error pages are not articles", () => {
    expect(probe({ location: "about:blank" }).ready).toBe(false);
    expect(probe({ title: "Access denied" }).ready).toBe(false);
    expect(probe({ title: "Just a moment..." }).challenge).toBe(true);
  });

  test("canonical article redirects with the same slug remain ready", () => {
    expect(probe({ location: url.replace(/\/\d+$/, "/7700890") }).ready).toBe(true);
    expect(probe({ location: url.replace("/42/", "/41/") }).ready).toBe(false);
  });

  test("challenge DOM and security text are detected before content appears", () => {
    expect(probe({ rootText: "", citation: "", challengeDom: true }).challenge).toBe(true);
    expect(probe({ rootText: "", body: "Verifying you are human" }).challenge).toBe(true);
  });

  test("CAPTCHA discussions and footer widgets do not block real articles", () => {
    expect(probe({ body: "We study CAPTCHA and verify you are human prompts", challengeDom: true }).ready).toBe(true);
  });

  test("issue readiness requires article links for the requested issue", () => {
    expect(probe({ links: [] }, "issue").ready).toBe(false);
    expect(probe({ links: [url.replace("/42/", "/41/")] }, "issue").ready).toBe(false);
    expect(probe({ links: [url] }, "issue").ready).toBe(true);
    expect(probe({ links: [url.replace("/article/", "/article-abstract/")] }, "issue").ready).toBe(true);
  });
});
