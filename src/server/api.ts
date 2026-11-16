/**
 * Route-handler wrapper: authentication, permission, same-origin check for
 * state-changing requests, input validation and consistent JSON errors.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError } from "./lib/errors";
import { requireUser, type SessionUser } from "./auth/session";
import type { Permission } from "./auth/permissions";
import type { Actor } from "./audit/audit";

export function actorOf(u: SessionUser, req?: NextRequest): Actor {
  return { id: u.id, label: u.name, ip: req?.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null };
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    const o = new URL(origin);
    if (o.host === host) return true;
    if (process.env.PUBLIC_BASE_URL && o.origin === new URL(process.env.PUBLIC_BASE_URL).origin) return true;
  } catch { /* fallthrough */ }
  return false;
}

export function errorResponse(e: unknown) {
  if (e instanceof AppError) return NextResponse.json({ error: e.code, message: e.message, details: e.details }, { status: e.status });
  if (e instanceof ZodError) return NextResponse.json({ error: "invalid", message: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  console.error("[api] unhandled", e);
  return NextResponse.json({ error: "server_error", message: "Something went wrong. The error has been logged." }, { status: 500 });
}

type Ctx = { params: Record<string, string> };

export function route<B = unknown>(opts: { perm?: Permission; body?: ZodType<B> }, fn: (a: { req: NextRequest; user: SessionUser; body: B; params: Record<string, string>; actor: Actor }) => Promise<unknown>) {
  return async (req: NextRequest, ctx: Ctx) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) throw new AppError("bad_origin", "Cross-site request blocked", 403);
      const user = await requireUser(opts.perm);
      let body = undefined as B;
      if (opts.body) body = opts.body.parse(await req.json().catch(() => ({})));
      const out = await fn({ req, user, body, params: ctx?.params ?? {}, actor: actorOf(user, req) });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) { return errorResponse(e); }
  };
}
