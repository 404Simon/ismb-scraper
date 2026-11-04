import { nameKey, type AuthorDetail } from "./authors";
import { countryFromAffiliation } from "./countries";

export interface LeadLabResult {
  count: number | null;
  countries: string[] | null;
}

/**
 * Compute |H| and the countries of H for the affiliation sets of the joint
 * first and joint senior authors.
 *
 * Lead authors without an extracted affiliation cannot constrain H, so they are
 * ignored. If no lead author has an affiliation, both values are unknown.
 */
export function computeLeadLabs(
  authors: AuthorDetail[],
  jointFirst: string[],
  jointSenior: string[]
): LeadLabResult {
  const byName = new Map(
    authors.map((author) => [nameKey(author.name), author])
  );
  const sets: string[][] = [];

  for (const name of unique([...jointFirst, ...jointSenior])) {
    const affiliations = unique(
      (byName.get(nameKey(name))?.affiliations ?? [])
        .map((affiliation) => normalizeAffiliation(affiliation))
        .filter(Boolean)
    );
    if (affiliations.length > 0) sets.push(affiliations);
  }

  if (sets.length === 0) {
    return { count: null, countries: null };
  }

  const hittingSet = minimumHittingSet(sets);
  const countries = new Set<string>();

  for (const affiliation of hittingSet) {
    const country = countryFromAffiliation(affiliation);
    if (!country) return { count: hittingSet.length, countries: null };
    countries.add(country);
  }

  return {
    count: hittingSet.length,
    countries: [...countries].sort()
  };
}

/** Exact minimum hitting set. The inputs are small enough for branch-and-bound. */
export function minimumHittingSet(sets: string[][]): string[] {
  const displayByKey = new Map<string, string>();
  const normalized: Set<string>[] = [];

  for (const set of sets) {
    const values = new Set<string>();
    for (const value of set) {
      const display = normalizeAffiliation(value);
      const key = display.toLowerCase();
      if (!key) continue;
      if (!displayByKey.has(key)) displayByKey.set(key, display);
      values.add(key);
    }
    if (values.size > 0) normalized.push(values);
  }

  if (normalized.length === 0) return [];

  let best: string[] | null = null;

  function search(uncovered: Set<string>[], chosen: string[]): void {
    if (best !== null && chosen.length >= best.length) return;
    if (uncovered.length === 0) {
      best = [...chosen];
      return;
    }

    let target = uncovered[0];
    for (const set of uncovered) {
      if (set.size < target.size) target = set;
    }

    for (const element of [...target].sort()) {
      search(
        uncovered.filter((set) => !set.has(element)),
        [...chosen, element]
      );
    }
  }

  search(normalized, []);
  return (best ?? []).map((key) => displayByKey.get(key) ?? key);
}

function normalizeAffiliation(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;]+$/g, "")
    .trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
