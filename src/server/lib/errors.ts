export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}
export const conflict = (msg: string, details?: unknown) => new AppError("conflict", msg, 409, details);
export const forbidden = (msg = "You are not allowed to do that") => new AppError("forbidden", msg, 403);
export const notFound = (msg = "Not found") => new AppError("not_found", msg, 404);
export const badRequest = (msg: string, details?: unknown) => new AppError("bad_request", msg, 400, details);
