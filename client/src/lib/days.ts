/** The longest range drawn day by day with its empty days; a longer one keeps only the days with figures. */
export const MAX_FILLED_DAYS = 400;

/**
 * Every day from `from` to `to` (ISO dates, both included), each with its row or `empty(date)`: a chart of
 * daily figures shows the days without sales as zero instead of joining 13/10 straight to 19/10. Days after
 * `today` are left out, as nothing can be recorded on them yet.
 */
export function everyDay<R extends { date: string }>(rows: R[], from: string, to: string, empty: (date: string) => R, today?: string): R[] {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const last = today && today < to ? today : to;
  if (!iso.test(from) || !iso.test(last) || from > last) return rows;
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: R[] = [];
  // Counted in UTC, so a change of clocks never skips or repeats a day.
  const day = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`).getTime();
  while (day.getTime() <= end) {
    if (out.length >= MAX_FILLED_DAYS) return rows;
    const date = day.toISOString().slice(0, 10);
    out.push(byDate.get(date) ?? empty(date));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  // A row outside the range (none is expected) is kept rather than dropped.
  for (const r of rows) if (r.date < from || r.date > last) out.push(r);
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
