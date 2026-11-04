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
  /** Set when author markers on the PDF first page resolved a joint note. */
  joint_source?: "pdf" | null;
  has_group_author: boolean;
  metrics: AuthorMetrics;
}

export interface AuthorMetadataOptions {
  /** Lazily read the first PDF page only when an unnamed joint note needs it. */
  firstPageText?: () => Promise<string | null>;
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

export async function buildAuthorMetadata(
  raw: RawAuthorData | null | undefined,
  fallbackAuthors: string[],
  options: AuthorMetadataOptions = {}
): Promise<AuthorMetadata> {
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
  const parsed = hasOupAuthors
    ? parseJointNotes(notes, authors)
    : { first: [], senior: [], unresolved: [] };
  const total = authors.length;

  const needsPdfFirst = parsed.first.length === 0 &&
    parsed.unresolved.some((note) => note.first);
  const needsPdfSenior = parsed.senior.length === 0 &&
    parsed.unresolved.some((note) => note.senior);
  const pdf = options.firstPageText && (needsPdfFirst || needsPdfSenior)
    ? resolvePdfJointAuthors(
        parsed.unresolved,
        authors,
        await options.firstPageText()
      )
    : null;

  const jointFirst = parsed.first.length
    ? parsed.first
    : pdf?.first.length
      ? pdf.first
      : total ? [authors[0].name] : [];
  const jointSenior = parsed.senior.length
    ? parsed.senior
    : pdf?.senior.length
      ? pdf.senior
      : total > 1 ? [authors[total - 1].name] : [];
  const jointSource = pdf && (
    (needsPdfFirst && pdf.first.length > 0) ||
    (needsPdfSenior && pdf.senior.length > 0)
  ) ? "pdf" : null;
  const lead = new Set([...jointFirst, ...jointSenior]);

  return {
    authors_detail: authors,
    author_notes: notes,
    joint_first: jointFirst,
    joint_senior: jointSenior,
    joint_source: jointSource,
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

interface UnresolvedJointNote {
  first: boolean;
  senior: boolean;
}

function parseJointNotes(
  notes: string[],
  authors: AuthorDetail[]
): { first: string[]; senior: string[]; unresolved: UnresolvedJointNote[] } {
  const first = new Set<string>();
  const senior = new Set<string>();
  const unresolved: UnresolvedJointNote[] = [];

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

    const firstUnresolved = isFirst && firstCount === 0;
    const seniorUnresolved = isSenior && seniorCount === 0;
    if (firstUnresolved || seniorUnresolved) {
      unresolved.push({ first: firstUnresolved, senior: seniorUnresolved });
    }
  }

  return {
    first: authors.filter((author) => first.has(author.name)).map((author) => author.name),
    senior: authors.filter((author) => senior.has(author.name)).map((author) => author.name),
    unresolved
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

const NOTE_MARKERS = new Set(["*", "†", "‡", "§", "¶", "#"]);

/**
 * Resolve an unnamed equal-contribution/joint-author note from the PDF first
 * page. The marker can sit on the note line (`†Equal contribution.`) or on the
 * line immediately before it (`†` then `equal contribution.`). If the marker or
 * the author names are ambiguous, return null so the caller keeps the defaults.
 */
function resolvePdfJointAuthors(
  unresolved: UnresolvedJointNote[],
  authors: AuthorDetail[],
  text: string | null
): { first: string[]; senior: string[] } | null {
  if (!text) return null;

  const abstractIndex = text.search(/^\s*abstract\s*$/im);
  const scope = abstractIndex > 0 ? text.slice(0, abstractIndex) : text;
  const markers = new Map<"first" | "senior", string | null>();
  const first = new Set<string>();
  const senior = new Set<string>();
  let resolved = false;

  for (const note of unresolved) {
    for (const kind of ["first", "senior"] as const) {
      if (!note[kind]) continue;
      if (!markers.has(kind)) markers.set(kind, pdfNoteMarker(scope, kind));
      const marker = markers.get(kind);
      if (!marker) continue;

      const names = markedAuthors(authors, scope, marker);
      if (!names) continue;

      for (const name of names) {
        if (kind === "first") first.add(name);
        else senior.add(name);
      }
      if (names.length) resolved = true;
    }
  }

  if (!resolved) return null;
  return {
    first: authors.filter((author) => first.has(author.name)).map((author) => author.name),
    senior: authors.filter((author) => senior.has(author.name)).map((author) => author.name)
  };
}

function pdfNoteMarker(text: string, kind: "first" | "senior"): string | null {
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || !jointKinds(line)[kind]) continue;

    const prefix = line.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? "";
    const direct = [...prefix].filter((char) => NOTE_MARKERS.has(char)).join("");
    if (direct) return direct;

    for (let previous = index - 1; previous >= Math.max(0, index - 3); previous--) {
      const candidate = lines[previous].trim();
      if (!candidate) continue;
      if ([...candidate].every((char) => NOTE_MARKERS.has(char))) return candidate;
      break;
    }
  }

  return null;
}

function markedAuthors(
  authors: AuthorDetail[],
  text: string,
  markers: string
): string[] | null {
  const positions: { author: AuthorDetail; start: number; end: number }[] = [];

  for (const author of authors) {
    const occurrence = findNameOccurrence(text, author.name);
    if (!occurrence) return null;
    positions.push({ author, ...occurrence });
  }

  positions.sort((a, b) => a.start - b.start);
  for (let index = 1; index < positions.length; index++) {
    if (positions[index].start < positions[index - 1].end) return null;
  }

  const marked = new Set<string>();
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index];
    const newline = text.indexOf("\n", position.end);
    const lineEnd = newline < 0 ? text.length : newline;
    const next = positions[index + 1];
    // Stop at the next author on the same line, otherwise at the line end, so
    // a later footnote marker cannot be attributed to the last author.
    const end = next && next.start < lineEnd ? next.start : lineEnd;
    const segment = text.slice(position.end, end);
    if ([...segment].some((char) => markers.includes(char))) {
      marked.add(position.author.name);
    }
  }

  return authors.filter((author) => marked.has(author.name)).map((author) => author.name);
}

function findNameOccurrence(
  text: string,
  name: string
): { start: number; end: number } | null {
  const key = nameKey(name);
  if (!key) return null;

  const { normalized, map } = searchableText(text);
  let from = 0;

  while (true) {
    const at = normalized.indexOf(key, from);
    if (at < 0) return null;
    const startsWord = at === 0 || normalized[at - 1] === " ";
    // Superscript affiliation numbers attach directly to the name in pdftotext.
    const after = normalized[at + key.length];
    const endsWord = after === undefined || after === " " || /\d/.test(after);
    if (startsWord && endsWord) {
      return {
        start: map[at],
        end: map[at + key.length - 1] + 1
      };
    }
    from = at + 1;
  }
}

function searchableText(text: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let pendingSpace = false;

  for (let index = 0; index < text.length; index++) {
    const folded = text[index].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    let hasCharacter = false;

    for (const char of folded) {
      if (!/[\p{L}\p{N}]/u.test(char)) continue;
      if (pendingSpace && normalized.length) {
        normalized += " ";
        map.push(index);
      }
      pendingSpace = false;
      normalized += char;
      map.push(index);
      hasCharacter = true;
    }

    if (!hasCharacter && normalized.length) pendingSpace = true;
  }

  return { normalized, map };
}

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

export function nameKey(value: string): string {
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
