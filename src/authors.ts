export interface AuthorDetail {
  name: string;
  affiliations: string[];
  country_hints: string[];
  orcid: string | null;
}

export interface RawAuthorData {
  authors: AuthorDetail[];
  notes: string[];
}

export interface AuthorMetrics {
  A_first: number;
  A_senior: number;
  A_lead: number;
  A_total: number;
}

export interface AuthorMetadata {
  authors_detail: AuthorDetail[];
  author_notes: string[];
  joint_first: string[];
  joint_senior: string[];
  has_group_author: boolean;
  metrics: AuthorMetrics;
}

/**
 * Runs inside the live OUP article page. The top-level author list is split
 * into `.al-author-name` (first ten) and `.al-author-name-more` (the rest),
 * so select the shared `.linked-name` link and walk up to its block.
 * The trailing empty author-notes block contains no `.linked-name`.
 */
export function authorExtractionScript(): string {
  return String.raw`
(() => {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const authors = [];

  for (const link of document.querySelectorAll(".al-authors-list .linked-name")) {
    const block = link.closest(".al-author-name, .al-author-name-more");
    if (!block) continue;
    const name = norm(link.textContent);
    if (!name) continue;

    const affiliations = [...block.querySelectorAll(".info-card-affilitation .aff")]
      .map((el) => norm(el.textContent)).filter(Boolean);
    const country_hints = [...block.querySelectorAll(".aff .country")]
      .map((el) => norm(el.textContent)).filter(Boolean);
    const orcidLink = block.querySelector('a[id^="contrib-orcid"]');
    const orcid = orcidLink
      ? (orcidLink.getAttribute("href") || norm(orcidLink.textContent)).trim()
      : "";

    authors.push({ name, affiliations, country_hints, orcid: orcid || null });
  }

  const notes = [...document.querySelectorAll(".al-authors-list .footnote-content")]
    .map((el) => norm(el.textContent)).filter(Boolean);

  return { authors, notes };
})()
`;
}

export function buildAuthorMetadata(
  raw: RawAuthorData | null | undefined,
  fallbackAuthors: string[]
): AuthorMetadata {
  const extracted = dedupeAuthors(raw?.authors ?? []);
  const hasOupAuthors = extracted.length > 0;
  const authors = hasOupAuthors
    ? extracted
    : dedupeAuthors(fallbackAuthors.map((name) => ({
        name,
        affiliations: [],
        country_hints: [],
        orcid: null
      })));

  const notes = uniqueStrings((raw?.notes ?? []).map(normalizeNote).filter(Boolean));
  // Without the OUP author block, author notes cannot be tied to the fallback
  // meta-author list, so keep the conservative single-first/single-senior defaults.
  const parsed = hasOupAuthors ? parseJointNotes(notes, authors) : { first: [], senior: [] };
  const total = authors.length;

  const jointFirst = parsed.first.length
    ? parsed.first
    : total ? [authors[0].name] : [];
  const jointSenior = parsed.senior.length
    ? parsed.senior
    : total > 1 ? [authors[total - 1].name] : [];
  const lead = new Set([...jointFirst, ...jointSenior]);

  return {
    authors_detail: authors,
    author_notes: notes,
    joint_first: jointFirst,
    joint_senior: jointSenior,
    has_group_author: authors.some((author) => isGroupAuthor(author.name)),
    metrics: {
      A_first: jointFirst.length,
      A_senior: jointSenior.length,
      A_lead: lead.size,
      A_total: total
    }
  };
}

interface NamedMatch {
  name: string;
  start: number;
  end: number;
}

function parseJointNotes(
  notes: string[],
  authors: AuthorDetail[]
): { first: string[]; senior: string[] } {
  const first = new Set<string>();
  const senior = new Set<string>();

  for (const note of notes) {
    const { first: isFirst, senior: isSenior } = jointKinds(note);
    if (!isFirst && !isSenior) continue;

    const named = matchNamedAuthors(note, authors);
    if (named === null) continue;

    if (named.length) {
      if (isFirst) for (const name of named) first.add(name);
      if (isSenior) for (const name of named) senior.add(name);
      continue;
    }

    const firstCount = isFirst ? ordinalCount(note, "first") : 0;
    if (firstCount > 0) {
      for (const author of authors.slice(0, firstCount)) first.add(author.name);
    }

    const seniorCount = isSenior ? ordinalCount(note, "senior") : 0;
    if (seniorCount > 0) {
      for (const author of authors.slice(-seniorCount)) senior.add(author.name);
    }
  }

  return {
    first: authors.filter((author) => first.has(author.name)).map((author) => author.name),
    senior: authors.filter((author) => senior.has(author.name)).map((author) => author.name)
  };
}

function jointKinds(note: string): { first: boolean; senior: boolean } {
  const text = note.toLowerCase();
  const firstSignal =
    /\bjoint(?:ly)?\s+(?:first|lead)\b/.test(text) ||
    /\bco-?first\b/.test(text) ||
    /\bequal(?:ly)?\s+contribut/.test(text) ||
    /\bcontributed\s+equally\b/.test(text) ||
    /\bequal\s+contribution\b/.test(text);
  const seniorSignal =
    /\bjoint(?:ly)?\s+senior\b/.test(text) ||
    /\bco-?senior\b/.test(text) ||
    /\bjoint(?:ly)?\s+supervis/.test(text) ||
    /\bjoint\s+supervision\b/.test(text) ||
    /\bjoint(?:ly)?\s+(?:last|final)\b/.test(text) ||
    /\bsenior\s+author\s+designation\b/.test(text);

  // "Equal contribution as second authors" is not a first-author claim.
  const secondAuthors = /\bas\s+(?:second|third|fourth|fifth|middle)\s+authors?\b/.test(text);
  const firstAuthors = /\bas\s+first\s+authors?\b/.test(text);

  return {
    first: firstSignal && (!secondAuthors || firstAuthors),
    senior: seniorSignal
  };
}

function ordinalCount(note: string, kind: "first" | "senior"): number {
  const text = note.toLowerCase();
  if (kind === "first" && /\bfirst\s+and\s+second\s+authors?\b/.test(text)) return 2;

  const pattern = kind === "first"
    ? /\bfirst\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+authors?\b/
    : /\b(?:last|final)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+authors?\b/;
  const match = text.match(pattern);
  if (!match) return 0;

  const token = match[1];
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? 0;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
};

function matchNamedAuthors(note: string, authors: AuthorDetail[]): string[] | null {
  const text = ` ${nameKey(note)} `;
  const counts = new Map<string, number>();

  for (const author of authors) {
    const key = nameKey(author.name);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const matches: NamedMatch[] = [];
  for (const author of authors) {
    const key = nameKey(author.name);
    if (!key || counts.get(key) !== 1) continue;

    let from = 0;
    while (true) {
      const start = text.indexOf(` ${key} `, from);
      if (start < 0) break;
      const contentStart = start + 1;
      matches.push({ name: author.name, start: contentStart, end: contentStart + key.length });
      from = start + 1;
    }
  }

  // A duplicated author name cannot be resolved from a note.
  for (const [key, count] of counts) {
    if (count > 1 && text.includes(` ${key} `)) return null;
  }
  if (!matches.length) return [];

  // Prefer the most specific name when one author name contains another.
  const kept = matches.filter((match) => !matches.some((other) =>
    other !== match &&
    other.start <= match.start &&
    other.end >= match.end &&
    other.end - other.start > match.end - match.start
  ));

  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      if (kept[i].start < kept[j].end && kept[j].start < kept[i].end) return null;
    }
  }

  const names = new Set(kept.map((match) => match.name));
  return authors.filter((author) => names.has(author.name)).map((author) => author.name);
}

function dedupeAuthors(authors: AuthorDetail[]): AuthorDetail[] {
  const byKey = new Map<string, AuthorDetail>();

  for (const author of authors) {
    const name = normalizeWhitespace(author.name);
    if (!name) continue;
    const key = nameKey(name);
    if (!key) continue;

    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, {
        name,
        affiliations: uniqueStrings(author.affiliations.map(normalizeWhitespace).filter(Boolean)),
        country_hints: uniqueStrings(author.country_hints.map(normalizeWhitespace).filter(Boolean)),
        orcid: author.orcid || null
      });
      continue;
    }

    current.affiliations = uniqueStrings([
      ...current.affiliations,
      ...author.affiliations.map(normalizeWhitespace).filter(Boolean)
    ]);
    current.country_hints = uniqueStrings([
      ...current.country_hints,
      ...author.country_hints.map(normalizeWhitespace).filter(Boolean)
    ]);
    current.orcid ||= author.orcid || null;
  }

  return [...byKey.values()];
}

function isGroupAuthor(name: string): boolean {
  return /\b(?:consortium|collaborat(?:ion|ive)|initiative|network|alliance|committee|investigators?|study\s+group|working\s+group|task\s+force|team)\b/i.test(name);
}

function normalizeNote(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^[\s=†‡*§¶]+/, "")
    // OUP sometimes drops the space between the last author and the note text.
    .replace(/(\p{Ll})(?=(?:Joint|joint|Equal|equal|Contributed|contributed)\b)/gu, "$1 ")
    .trim();
}

function nameKey(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
