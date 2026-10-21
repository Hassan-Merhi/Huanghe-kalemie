type T = (en: string, fr: string) => string;

/** An engine number as compared: capitals, no spaces ("162fmj 800001 " is 162FMJ800001). */
export function engineKey(engineNo: string | null | undefined): string {
  return (engineNo ?? "").replace(/\s+/g, "").toUpperCase();
}

/**
 * Engine numbers typed on more than one motorcycle, line by line: twice in the dialog, or already on a
 * registered bike (the lines' own bikes aside, since their engine is the one typed). Only a question: the
 * number is not checked by the server and an old typo may sit on the other bike, so saving stays possible.
 * A line left out of the save (`saved: false`, no chassis typed yet) keeps its bike's registered engine.
 */
export function engineRepeats(
  t: T,
  lines: { id: number; engineNo: string; saved?: boolean }[],
  registered: { id: number; chassisNo: string | null; engineNo: string | null; productName?: string }[],
): Map<number, string> {
  const own = new Set(lines.filter((l) => l.saved !== false).map((l) => l.id));
  const onFile = new Map<string, (typeof registered)[number]>();
  for (const u of registered) {
    const k = engineKey(u.engineNo);
    if (k && !own.has(u.id) && !onFile.has(k)) onFile.set(k, u);
  }
  const keys = lines.map((l) => (l.saved === false ? "" : engineKey(l.engineNo)));
  const out = new Map<number, string>();
  keys.forEach((k, i) => {
    if (!k) return;
    const other = onFile.get(k);
    if (other) {
      const name = other.productName ? ` (${other.productName})` : "";
      const where = other.chassisNo ?? t(`another motorcycle${name}`, `une autre moto${name}`);
      out.set(i, t(`Engine number ${k} is already on ${where}`, `Le numéro de moteur ${k} est déjà sur ${where}`));
      return;
    }
    const first = keys.indexOf(k);
    const again = keys.indexOf(k, first + 1);
    if (again !== -1) {
      out.set(i, t(`Engine number ${k} is typed twice (bikes ${first + 1} and ${again + 1})`, `Le numéro de moteur ${k} est saisi deux fois (motos ${first + 1} et ${again + 1})`));
    }
  });
  return out;
}
