import { describe, expect, it } from "vitest";

describe("fifteenth UI audit: contacts typed twice", async () => {
  const { duplicateParty, nameKey, phoneKey } = await import("../../client/src/lib/labels");
  const parties = [
    { id: 1, name: "Garage Mwamba", phone: "+243 97 123 4567" },
    { id: 2, name: "Atelier Bahati", phone: null },
    { id: 3, name: "Kabila", phone: "12345" },
  ];

  it("reads one name whatever the case, accents and spaces", () => {
    expect(nameKey("garage  mwamba")).toBe(nameKey("Garage Mwamba"));
    expect(nameKey("Garage Mwambá.")).toBe("garagemwamba");
    expect(duplicateParty(parties, { name: "garage mwamba" })).toEqual({ party: parties[0], by: "name" });
    expect(duplicateParty(parties, { name: " ATELIER   BAHATI " })?.party.id).toBe(2);
  });

  it("matches a phone typed with or without the country code", () => {
    expect(phoneKey("0971234567")).toBe(phoneKey("+243 97 123 4567"));
    expect(duplicateParty(parties, { name: "Mwamba Jean", phone: "097 123 45 67" })).toEqual({ party: parties[0], by: "phone" });
    // Short numbers are not compared: "12345" is not a phone worth a question.
    expect(duplicateParty(parties, { name: "Autre", phone: "12345" })).toBeNull();
  });

  it("leaves new names alone and does not flag the contact being edited", () => {
    expect(duplicateParty(parties, { name: "Garage Mwamba Fils" })).toBeNull();
    expect(duplicateParty(parties, { name: "Garage Mwamba", phone: "+243971234567", selfId: 1 })).toBeNull();
    expect(duplicateParty(parties, { name: "" })).toBeNull();
  });
});
