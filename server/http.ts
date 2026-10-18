import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, z } from "zod";
import { MoneyError } from "@shared/money";
import { frenchSpacing } from "@shared/french";
import { AppError } from "./errors";
import { log } from "./log";

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Field names as a person reads them, with whether they are feminine (for "supérieur(e)"). */
const FIELDS_FR: Record<string, [string, boolean]> = {
  amount: ["le montant", false],
  qty: ["la quantité", true],
  qtyChange: ["la quantité", true],
  unitPrice: ["le prix", false],
  unitCost: ["le coût", false],
  sellPrice: ["le prix de vente", false],
  lineDiscount: ["la remise", true],
  discount: ["la remise", true],
  rate: ["le taux", false],
  cdfPerUsd: ["le taux", false],
  date: ["la date", true],
  accountId: ["le compte", false],
  partyId: ["le contact", false],
  nativeAmount: ["le montant en FC", false],
  debit: ["le débit", false],
  credit: ["le crédit", false],
};
const LISTS_FR: Record<string, string> = { lines: "Ligne", payments: "Paiement", variants: "Variante" };

/**
 * A validation error in words: "Ligne 1 : le montant doit être supérieur à zéro." rather than the field
 * path "(lines.0.amount)". Null when the field or the rule is not one of the common ones.
 */
export function zodIssueFr(issue: { path: PropertyKey[]; message: string } | undefined): string | null {
  if (!issue) return null;
  let where = "";
  let field: [string, boolean] | undefined;
  for (let i = 0; i < issue.path.length; i++) {
    const key = issue.path[i];
    const next = issue.path[i + 1];
    if (typeof key === "string" && LISTS_FR[key] && typeof next === "number") {
      where = `${LISTS_FR[key]} ${next + 1}`;
      i++;
    } else if (typeof key === "string") field = FIELDS_FR[key];
  }
  if (!field) return null;
  const e = field[1] ? "e" : "";
  const rules: Record<string, string> = {
    "Must be greater than zero": `doit être supérieur${e} à zéro`,
    "Must be a number": "doit être un nombre",
    "Cannot be negative": `ne peut pas être négati${field[1] ? "ve" : "f"}`,
    [tooLarge]: `doit être inférieur${e} à 1\u00a0000\u00a0000\u00a0000\u00a0000`,
    "Must be less than 1 000 000": `doit être inférieur${e} à 1\u00a0000\u00a0000`,
    "Use a date like 2026-10-12": "doit être une date comme 2026-10-12",
  };
  const rule = rules[issue.message] ?? `est manquant${e} ou invalide`;
  const subject = where ? `${where} : ${field[0]}` : field[0].charAt(0).toUpperCase() + field[0].slice(1);
  return `${subject} ${rule}.`;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return res.status(400).json({
      message: `${where}${first?.message ?? "Invalid input"}`,
      messageFr: frenchSpacing(zodIssueFr(first) ?? "Saisie incomplète ou invalide. Vérifiez les champs et réessayez."),
      code: "VALIDATION",
      issues: err.issues,
    });
  }
  // French messages get their no-break spaces here, so none of the many messages can wrap before a colon.
  if (err instanceof AppError) return res.status(err.status).json({ message: err.message, messageFr: err.messageFr && frenchSpacing(err.messageFr), code: err.code });
  if (err instanceof MoneyError) return res.status(422).json({ message: err.message, messageFr: frenchSpacing(err.messageFr ?? "Montant invalide"), code: "INVALID_AMOUNT" });
  const pgCode = (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  if (pgCode === "23505") return res.status(409).json({ message: "That value is already used", messageFr: "Cette valeur est déjà utilisée", code: "DUPLICATE" });
  // A product of two large inputs that no column can hold (quantity × price): refused like any other bad input.
  if (pgCode === "22003") {
    return res.status(400).json({
      message: "A number is too large for the books",
      messageFr: frenchSpacing("Un nombre est trop grand pour la comptabilité. Vérifiez les montants et les quantités."),
      code: "VALIDATION",
    });
  }
  if (pgCode === "23514") return res.status(409).json({ message: "Not enough stock for this change", messageFr: "Stock insuffisant pour cette opération", code: "CHECK" });
  log("Unhandled error", { path: req.path, error: err instanceof Error ? err.stack ?? err.message : String(err) });
  res.status(500).json({ message: "Something went wrong. Please try again.", messageFr: "Une erreur est survenue. Réessayez.", code: "INTERNAL" });
}

// ---------------------------------------------------------------- Shared validators

// Postgres has no year 0, and nothing in these books is older than 1900: "0000-01-01" is a typo, not a date.
// A day the calendar does not have ("2026-02-30") is refused here too, rather than by the database.
export const isoDate = z
  .string()
  .regex(/^(19|[2-9]\d)\d{2}-\d{2}-\d{2}$/, "Use a date like 2026-10-12")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Use a date like 2026-10-12");
export const month = z.string().regex(/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/, "Use a month like 2026-10");
/**
 * Every amount, quantity and cost the books hold stays below a trillion (12 digits before the point),
 * in any currency: quantities are numeric(15,3), so that is also what the columns can hold, and
 * nothing this shop does comes near it. Rates stay below a million (1 $ = 2 800 FC or 7,1 ¥).
 */
export const MAX_DIGITS = 12;
export const MAX_RATE_DIGITS = 6;
/** Digits before the decimal point of a plain number text ("-0012.50" has 2). */
export const integerDigits = (v: string) => v.replace(/^[-+]/, "").split(".")[0].replace(/^0+/, "").length;
const tooLarge = `Must be less than 1 000 000 000 000`;
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), "Must be a number")
  .refine((v) => integerDigits(v) <= MAX_DIGITS, tooLarge);
export const positiveDecimal = decimalString.refine((v) => Number(v) > 0, "Must be greater than zero");
export const nonNegativeDecimal = decimalString.refine((v) => Number(v) >= 0, "Cannot be negative");
export const optionalDecimal = z.union([decimalString, z.literal(""), z.null()]).optional().transform((v) => (v === "" ? null : v ?? null));
/** An exchange rate: how many francs or yuan for 1 $, or a container's dollars per unit of its currency. */
const rateBound = (v: string) => integerDigits(v) <= MAX_RATE_DIGITS;
export const positiveRate = positiveDecimal.refine(rateBound, "Must be less than 1 000 000");
export const optionalRate = z.union([decimalString.refine(rateBound, "Must be less than 1 000 000"), z.literal(""), z.null()]).optional().transform((v) => (v === "" ? null : v ?? null));
export const id = z.coerce.number().int().positive();
export const optionalId = z.union([z.coerce.number().int().positive(), z.null(), z.literal("")]).optional().transform((v) => (v === "" || v === undefined ? null : v));

export function todayIso(): string {
  // Kalemie is UTC+2.
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

export function paramId(req: Request, name = "id"): number {
  return id.parse(req.params[name]);
}
