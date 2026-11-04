/** Extract a four-digit publication year from a date string. */
export function parsePublicationYear(value: string | null | undefined): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const match = text.match(/\b(?:1[89]\d{2}|20\d{2}|2100)\b/);
  return match ? Number(match[0]) : null;
}
