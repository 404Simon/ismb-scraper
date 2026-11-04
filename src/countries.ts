interface CountryEntry {
  key: string;
  name: string;
}

const EXTRA_ALIASES: Record<string, string[]> = {
  AE: ["uae", "u a e", "united arabic emirates"],
  CN: ["prc", "p r china", "people s republic of china", "mainland china"],
  CZ: ["czech republic"],
  GB: [
    "uk",
    "u k",
    "great britain",
    "britain",
    "england",
    "scotland",
    "wales",
    "northern ireland"
  ],
  HK: ["hong kong"],
  IR: ["islamic republic of iran"],
  KR: ["korea", "republic of korea", "r o k"],
  NL: ["holland"],
  RU: ["russian federation"],
  TR: ["turkey"],
  US: ["usa", "u s a", "u s", "us", "united states of america"],
  VN: ["viet nam"]
};

let countryTable: CountryEntry[] | null = null;

/**
 * Extract the country from an affiliation string. Countries normally appear in
 * the last one or two comma-separated segments, so the whole institution name is
 * not searched for country names.
 */
export function countryFromAffiliation(affiliation: string): string | null {
  const segments = String(affiliation ?? "")
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);

  const start = Math.max(0, segments.length - 2);
  for (let index = segments.length - 1; index >= start; index--) {
    const country = matchCountry(segments[index]);
    if (country) return country;
  }
  return null;
}

function matchCountry(value: string): string | null {
  const text = normalizeCountryText(value);
  if (!text) return null;

  for (const entry of getCountryTable()) {
    if (containsPhrase(text, entry.key)) return entry.name;
  }
  return null;
}

function getCountryTable(): CountryEntry[] {
  if (countryTable !== null) return countryTable;

  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const entries: CountryEntry[] = [];

  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        continue;
      }
      if (!name || name === code || /unknown/i.test(name)) continue;

      entries.push({ key: normalizeCountryText(name), name });
      for (const alias of EXTRA_ALIASES[code] ?? []) {
        entries.push({ key: normalizeCountryText(alias), name });
      }
    }
  }

  entries.sort((left, right) => right.key.length - left.key.length);
  countryTable = entries;
  return entries;
}

function containsPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}

function normalizeCountryText(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
