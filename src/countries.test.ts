import { describe, expect, test } from "bun:test";
import { countryFromAffiliation } from "./countries";

describe("country extraction from affiliations", () => {
  test("reads common country-name endings", () => {
    expect(
      countryFromAffiliation(
        "Department of Molecular Life Sciences, University of Zurich, Zurich, 8057, Switzerland"
      )
    ).toBe("Switzerland");
    expect(
      countryFromAffiliation(
        "Department of Mathematics, University of Toronto, Toronto, Ontario, M5S 2E4, Canada"
      )
    ).toBe("Canada");
  });

  test("handles country codes and aliases", () => {
    expect(
      countryFromAffiliation(
        "Paul G. Allen School of Computer Science and Engineering, University of Washington, Seattle, WA 98195, USA"
      )
    ).toBe("United States");
    expect(
      countryFromAffiliation(
        "Department of Computer Science, Example University, London, UK"
      )
    ).toBe("United Kingdom");
    expect(
      countryFromAffiliation(
        "Machine Learning Department, Example University, Abu Dhabi, 00000, United Arabic Emirates"
      )
    ).toBe("United Arab Emirates");
  });

  test("normalizes accents and local spellings", () => {
    expect(
      countryFromAffiliation(
        "Centro de Ciencias Matemáticas, Universidad Nacional Autónoma de México, Morelia 58089, México"
      )
    ).toBe("Mexico");
    expect(
      countryFromAffiliation(
        "Department of Computer Engineering, Bilkent University, Ankara 06800, Türkiye"
      )
    ).toBe("Türkiye");
  });

  test("handles a trailing postal code", () => {
    expect(
      countryFromAffiliation(
        "Department of Biosystems Science and Engineering, ETH Zurich, Switzerland, 4056"
      )
    ).toBe("Switzerland");
  });

  test("does not treat a US state as the country Georgia", () => {
    expect(
      countryFromAffiliation(
        "School of Computer Science, Example University, Athens, GA 30602"
      )
    ).toBeNull();
  });

  test("returns null when no country is present", () => {
    expect(countryFromAffiliation("")).toBeNull();
    expect(countryFromAffiliation("Some Department, Some University")).toBeNull();
  });

});
