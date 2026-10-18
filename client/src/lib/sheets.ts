import * as XLSX from "xlsx";
import { ambiguousImportMeasure, ambiguousTypedAmount, Decimal, parseTypedAmount, parseTypedNumber, typedWholeCountDoubt } from "@shared/money";

/*
 * Spreadsheet helpers: CSV download, Excel templates and reading an uploaded .xlsx / .xls / .csv.
 * Files are read in the browser; only the rows go to the server.
 */

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename: string, rows: unknown[][]) {
  const text = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  download(filename, new Blob([text], { type: "text/csv;charset=utf-8" }));
}

/** An .xlsx with one sheet: a header row and optional example rows. */
export function downloadXlsx(filename: string, rows: unknown[][], sheet = "Feuille1") {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = (rows[0] ?? []).map((h) => ({ wch: Math.max(12, String(h ?? "").length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  download(filename, new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** CSV text in UTF-8 (with or without the mark Excel adds) or, failing that, in Windows Western encoding. */
export function decodeCsv(bytes: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^\uFEFF/, "");
}

/** The separator a CSV uses: French Excel writes ";", others ",", some tabs. */
export function csvSeparator(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [";", ",", "\t"].map((c) => [c, first.split(c).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ",";
}

/** Columns that hold numbers: "12,50" and "1 250,00" are read the French way. */
const NUMBER_FIELDS = new Set(["sellPrice", "reorderLevel", "qty", "unitCost", "quantity", "unitPrice", "weightKg", "volumeCbm"]);
/** Prices and costs, where text such as "4,125" or "1.350" is asked about, as the server refuses it (see ambiguousTypedAmount). */
const AMOUNT_FIELDS = new Set(["sellPrice", "unitCost", "unitPrice"]);

async function readWorkbook(file: File) {
  const buf = await file.arrayBuffer();
  if (/\.(csv|txt)$/i.test(file.name) || file.type === "text/csv") {
    const text = decodeCsv(buf);
    // Cells stay text (raw), so "12,50" is not read as 1250; the server reads French and English numbers.
    return XLSX.read(text, { type: "string", raw: true, FS: csvSeparator(text), cellDates: false });
  }
  return XLSX.read(buf, { type: "array", cellDates: false });
}

/**
 * Read the first sheet of a file into objects keyed by our field names.
 * `fields` maps a field to the header names it accepts (any case, accents and spaces ignored).
 * Returns the rows, the fields whose column was found, and each row's number cells as they were in the
 * file (a page that knows the unit reads "2,250" litres again as 2,25: see parseTypedNumber).
 */
export async function readSheet<F extends string>(file: File, fields: Record<F, string[]>) {
  const wb = await readWorkbook(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [] as Record<F, string | null>[], found: [] as F[], cells: [] as Partial<Record<F, string | number>>[] };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const header = (grid[0] ?? []).map((h) => strip(String(h ?? "")));
  const colOf = {} as Record<F, number>;
  const found: F[] = [];
  for (const [field, names] of Object.entries(fields) as [F, string[]][]) {
    const idx = header.findIndex((h) => names.map(strip).includes(h));
    colOf[field] = idx;
    if (idx >= 0) found.push(field);
  }
  const cells: Partial<Record<F, string | number>>[] = [];
  const rows = grid
    .slice(1)
    .filter((r) => r.some((c) => c !== null && String(c).trim() !== ""))
    .map((r) => {
      const o = {} as Record<F, string | null>;
      const raw: Partial<Record<F, string | number>> = {};
      for (const f of Object.keys(fields) as F[]) {
        const v = colOf[f] >= 0 ? r[colOf[f]] : null;
        const empty = v === null || v === undefined || String(v).trim() === "";
        if (!empty && NUMBER_FIELDS.has(f)) raw[f] = typeof v === "number" ? v : String(v).trim();
        o[f] = empty ? null : AMOUNT_FIELDS.has(f) ? parseTypedAmount(v) : NUMBER_FIELDS.has(f) ? parseTypedNumber(v) : String(v).trim();
      }
      cells.push(raw);
      return o;
    });
  return { rows, found, cells };
}

/**
 * A number cell read for what it holds: a measure (litres, metres, kilos, and every weight and volume) reads
 * "2,250" as 2,25 as a form field does, and asks about "1.000" or "1,000" (`unsure`: 1 000 or 1). A count of
 * whole units asks about text "12,000" or "12.000" too (12 or 12 000?), and "1,500" comes back as `split`
 * (["1.5", "1500"]: 1,5 in a French sheet, which no piece can be) rather than as 1 500 pieces (see
 * typedWholeCountDoubt).
 */
export function readNumberCell(
  raw: string | number | null | undefined,
  measured: boolean,
): { value: string | null; unsure: [string, string] | null; split?: [string, string] } {
  if (raw === null || raw === undefined) return { value: null, unsure: null };
  if (measured) return { value: parseTypedNumber(raw, { measured: true }), unsure: ambiguousImportMeasure(raw) };
  const doubt = typedWholeCountDoubt(raw);
  if (doubt && "split" in doubt) return { value: doubt.split, unsure: null, split: [doubt.split, doubt.whole] };
  return { value: parseTypedNumber(raw), unsure: doubt?.unsure ?? null };
}

/**
 * A price or cost cell in doubt: text such as "4,125", "1.350" or "1,000" may be thousands or three decimals,
 * and the server refuses it, so the page asks first. A number cell (0.125) never is.
 */
export function amountCellUnsure(raw: string | number | null | undefined): [string, string] | null {
  return ambiguousTypedAmount(raw);
}

/**
 * Rows as sent to the server: each number field the page read ("0.125", "4125") goes as a JSON number, so the
 * server books exactly the value shown and never reads "4.125" again as text that could be thousands.
 */
export function toWire<R extends Record<string, unknown>>(row: R): R {
  const out: Record<string, unknown> = { ...row };
  for (const f of NUMBER_FIELDS) {
    const v = out[f];
    if (typeof v !== "string" || !/^-?\d+(\.\d+)?$/.test(v)) continue;
    // Only when the number carries the value exactly (a 20-digit typo stays text, for the server to refuse).
    const n = Number(v);
    if (Number.isFinite(n) && new Decimal(String(n)).equals(v)) out[f] = n;
  }
  return out as R;
}
