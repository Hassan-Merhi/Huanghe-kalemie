import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, z } from "zod";
import { MoneyError } from "@shared/money";
import { AppError } from "./errors";
import { log } from "./log";

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return res.status(400).json({ message: `${where}${first?.message ?? "Invalid input"}`, code: "VALIDATION", issues: err.issues });
  }
  if (err instanceof AppError) return res.status(err.status).json({ message: err.message, code: err.code });
  if (err instanceof MoneyError) return res.status(422).json({ message: err.message, code: "INVALID_AMOUNT" });
  const pgCode = (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  if (pgCode === "23505") return res.status(409).json({ message: "That value is already used", code: "DUPLICATE" });
  if (pgCode === "23514") return res.status(409).json({ message: "Not enough stock for this change", code: "CHECK" });
  log("Unhandled error", { path: req.path, error: err instanceof Error ? err.stack ?? err.message : String(err) });
  res.status(500).json({ message: "Something went wrong. Please try again.", code: "INTERNAL" });
}

// ---------------------------------------------------------------- Shared validators

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-12");
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-10");
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), "Must be a number");
export const positiveDecimal = decimalString.refine((v) => Number(v) > 0, "Must be greater than zero");
export const nonNegativeDecimal = decimalString.refine((v) => Number(v) >= 0, "Cannot be negative");
export const optionalDecimal = z.union([decimalString, z.literal(""), z.null()]).optional().transform((v) => (v === "" ? null : v ?? null));
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
