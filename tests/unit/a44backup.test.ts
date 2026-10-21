import { describe, expect, it } from "vitest";
import { downloadStarted } from "../../client/src/lib/backupStatus";

describe("A44 (UI audit 53): the backup tab right after \"Télécharger maintenant\"", () => {
  it("says the download started until the list shows a newer one, never that none was made", () => {
    // Not clicked: the tab shows the last download, or that there is none.
    expect(downloadStarted(undefined, null)).toBe(false);
    expect(downloadStarted(undefined, "2026-10-01T08:00:00Z")).toBe(false);
    // Clicked with no download yet: started, until the refetch brings the first one.
    expect(downloadStarted(null, null)).toBe(true);
    expect(downloadStarted(null, undefined)).toBe(true);
    expect(downloadStarted(null, "2026-10-21T09:00:00Z")).toBe(false);
    // Clicked after an older download: started until the newer one shows.
    expect(downloadStarted("2026-10-01T08:00:00Z", "2026-10-01T08:00:00Z")).toBe(true);
    expect(downloadStarted("2026-10-01T08:00:00Z", "2026-10-21T09:00:00Z")).toBe(false);
  });
});
