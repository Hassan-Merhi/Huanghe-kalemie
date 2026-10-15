/**
 * Errors shown to the user. Each carries an English and a French message; the client shows the
 * one matching the chosen language.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "APP_ERROR",
    public readonly messageFr?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, fr?: string) => new AppError(400, message, "BAD_REQUEST", fr);
export const notFound = (what = "Record", fr?: string) => new AppError(404, `${what} not found`, "NOT_FOUND", fr ?? `${what} introuvable`);
export const conflict = (message: string, fr?: string) => new AppError(409, message, "CONFLICT", fr);
export const forbidden = (message = "You do not have access to this", fr = "Vous n'avez pas accès à cette action") => new AppError(403, message, "FORBIDDEN", fr);

/** A fractional quantity of something counted in pieces, sets, pairs, boxes or rolls. */
export const wholeUnitError = (item: string) =>
  badRequest(`${item} is counted in whole units: use a whole number`, `${item} se compte à l'unité : saisissez un nombre entier`);

/** Francs are counted in whole notes; an amount with centimes is a typing slip. */
export const francDecimalsError = (amount: { toString(): string }) =>
  badRequest(`Franc amounts are whole numbers (${amount.toString()} FC has decimals)`, `Les montants en FC sont des nombres entiers (${amount.toString().replace(".", ",")} FC a des décimales)`);
