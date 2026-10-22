/**
 * Whether a download started from the backup tab is still under way: `startedFrom` is the last download as
 * the tab showed it when "Download now" was clicked (undefined: not clicked), `last` the one it shows now.
 * Until the list shows a newer one, the tab says the download started rather than that none was ever made.
 */
export function downloadStarted(startedFrom: string | null | undefined, last: string | null | undefined): boolean {
  return startedFrom !== undefined && (last ?? null) === startedFrom;
}
