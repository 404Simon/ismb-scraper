export type PageKind = "issue" | "article";

export interface PageState {
  url: string;
  title: string;
  challenge: boolean;
  ready: boolean;
  signature: string;
}

interface PageView {
  navigate(url: string): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
}

interface ReadOptions {
  interactive: boolean;
  timeoutMs: number;
  retries?: number;
  stableMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (message: string) => void;
}

// Positive content checks matter: a blank redirect document is not a cleared challenge.
export function pageStateScript(kind: PageKind, url: string): string {
  return `(() => {
    const expected = new URL(${JSON.stringify(url)});
    const body = document.body;
    const title = document.title || "";
    const text = (body?.innerText || "").trim();
    const root = document.querySelector("article, .article-body, .js-article-body, .widget-ArticleFulltext, main");
    const citation = document.querySelector('meta[name="citation_title" i]')?.getAttribute("content")?.trim();
    const articleText = (root?.textContent || "").trim();
    const links = [...document.querySelectorAll("a[href]")].filter(a => {
      try {
        const target = new URL(a.href, location.href);
        const prefix = expected.pathname.replace("/issue/", "/article/").replace(/\\/$/, "") + "/";
        return target.hostname === expected.hostname &&
          target.pathname.replace("/article-abstract/", "/article/").startsWith(prefix);
      } catch { return false; }
    });
    const articleReady = Boolean(citation && root && articleText.length > 200);
    const issueReady = links.length > 0;
    const contentReady = ${JSON.stringify(kind)} === "article" ? articleReady : issueReady;
    const challengeTitle = /just a moment|attention required|access denied|security verification/i.test(title);
    const challengeText = /verify (?:that )?you are human|verifying you are human|checking your browser|performing security verification|unusual traffic|needs to review the security|enable javascript and cookies to continue/i.test(text.slice(0, 4000));
    const challengeDom = Boolean(document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, .cf-challenge, iframe[src*="challenges.cloudflare.com"]'));
    // An article may discuss CAPTCHAs or embed a Turnstile widget in its footer.
    const challenge = challengeTitle || (!contentReady && (challengeText || challengeDom));
    const actualPath = location.pathname.replace("/article-abstract/", "/article/").replace(/\\/$/, "");
    const expectedPath = expected.pathname.replace("/article-abstract/", "/article/").replace(/\\/$/, "");
    // OUP sometimes redirects an article to a canonical numeric id while keeping the slug.
    const actualArticle = actualPath.replace(/\\/\\d+$/, "");
    const expectedArticle = expectedPath.replace(/\\/\\d+$/, "");
    const correctUrl = location.hostname === expected.hostname &&
      (${JSON.stringify(kind)} === "article" ? actualArticle === expectedArticle : actualPath === expectedPath);
    const content = ${JSON.stringify(kind)} === "article"
      ? articleText + "|" + root?.querySelectorAll("a,img,figure").length
      : links.map(a => a.href + "|" + a.textContent).join("\\n");
    let hash = 0;
    for (let i = 0; i < content.length; i++) hash = (hash * 31 + content.charCodeAt(i)) | 0;
    return {
      url: location.href, title, challenge,
      ready: Boolean(body && document.readyState === "complete" && correctUrl && contentReady && !challenge),
      signature: location.href + "|" + performance.timeOrigin + "|" + hash
    };
  })()`;
}

class PageTimeoutError extends Error {
  constructor(message: string, readonly challenged: boolean) { super(message); }
}

class HeadlessChallengeError extends Error {}

export async function readReadyPage<T>(
  view: PageView,
  url: string,
  kind: PageKind,
  extract: () => Promise<T>,
  options: ReadOptions
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  const log = options.log ?? console.warn;
  const retries = options.retries ?? 2;
  const probe = pageStateScript(kind, url);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // A navigation timeout can leave a usable page or a challenge open in Chrome.
      // Inspect it before deciding whether another navigation is needed.
      try { await view.navigate(url); }
      catch (error) { log(`Navigation interrupted at ${url}; waiting for content: ${message(error)}`); }

      let deadline = now() + options.timeoutMs;
      let stableSince: number | null = null;
      let signature = "";
      let challenged = false;
      let lastStatus = "page has not loaded";
      let nextProgress = now() + 30_000;

      while (true) {
        try {
          const state = await view.evaluate(probe) as PageState;
          if (!state || typeof state.ready !== "boolean") throw new Error("No page state returned");
          lastStatus = `${state.title || "untitled page"} (${state.url})`;
          if (state.challenge) {
            if (!options.interactive) {
              throw new HeadlessChallengeError(`Browser challenge detected at ${url}. Re-run with --chrome-debug-port and complete the verification in the visible Chrome window.`);
            }
            if (!challenged) {
              // Allow the full verification timeout when a delayed challenge first appears.
              challenged = true;
              deadline = now() + options.timeoutMs;
              log(`Cloudflare verification is open for ${url}`);
              log("Complete the verification in the attached Chrome window; scraping will continue once the page content is ready.");
            }
          }

          if (!state.ready) {
            stableSince = null;
            signature = "";
          } else {
            if (state.signature !== signature || stableSince === null) {
              signature = state.signature;
              stableSince = now();
            }
            if (now() - stableSince >= (options.stableMs ?? 3000)) {
              const result = await extract();
              // Discovery can await fetches; a redirect during extraction invalidates the result.
              const after = await view.evaluate(probe) as PageState;
              if (after?.ready && after.signature === signature) return result;
              stableSince = null;
              signature = "";
            }
          }
        } catch (error) {
          if (error instanceof HeadlessChallengeError) throw error;
          // Chrome destroys execution contexts during redirects. Keep the same tab open.
          lastStatus = message(error);
          stableSince = null;
          signature = "";
        }

        if (now() >= deadline) {
          throw new PageTimeoutError(`Page content did not become ready within ${options.timeoutMs / 1000}s at ${url}; last state: ${lastStatus}`, challenged);
        }
        if (now() >= nextProgress) {
          log(`Still waiting for ${kind} content at ${url} (${Math.ceil((deadline - now()) / 1000)}s remaining); ${lastStatus}`);
          nextProgress = now() + 30_000;
        }
        await sleep(Math.min(options.pollMs ?? 500, deadline - now()));
      }
    } catch (error) {
      // Never reload an unresolved manual challenge: that can erase verification progress.
      if (error instanceof HeadlessChallengeError ||
          (error instanceof PageTimeoutError && error.challenged) || attempt === retries) throw error;
      const backoff = Math.min(2000 * 2 ** attempt, 10_000);
      log(`Retrying ${kind} page (${attempt + 1}/${retries}) at ${url} in ${backoff / 1000}s: ${message(error)}`);
      await sleep(backoff);
    }
  }
  throw new Error(`Could not load ${url}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
