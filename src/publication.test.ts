import { describe, expect, test } from "bun:test";
import { parsePublicationYear } from "./publication";

describe("publication year parsing", () => {
  test("reads ISO and slash-separated dates", () => {
    expect(parsePublicationYear("2024-06-28")).toBe(2024);
    expect(parsePublicationYear("2024/06/28")).toBe(2024);
    expect(parsePublicationYear("2025-01-01T00:00:00Z")).toBe(2025);
  });

  test("reads a bare year and prose dates", () => {
    expect(parsePublicationYear("2026")).toBe(2026);
    expect(parsePublicationYear("Published online 28 June 2024")).toBe(2024);
    expect(parsePublicationYear("06/28/2024")).toBe(2024);
  });

  test("returns null for missing or out-of-range values", () => {
    expect(parsePublicationYear("")).toBeNull();
    expect(parsePublicationYear(null)).toBeNull();
    expect(parsePublicationYear(undefined)).toBeNull();
    expect(parsePublicationYear("n.d.")).toBeNull();
    expect(parsePublicationYear("1700-01-01")).toBeNull();
    expect(parsePublicationYear("20242")).toBeNull();
  });
});
