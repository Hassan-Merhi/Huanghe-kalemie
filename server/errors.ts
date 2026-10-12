export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "APP_ERROR",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string) => new AppError(400, message, "BAD_REQUEST");
export const notFound = (what = "Record") => new AppError(404, `${what} not found`, "NOT_FOUND");
export const conflict = (message: string) => new AppError(409, message, "CONFLICT");
export const forbidden = (message = "You do not have access to this") => new AppError(403, message, "FORBIDDEN");
