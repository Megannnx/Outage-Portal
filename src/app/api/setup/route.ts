import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/server/api";
import { needsFirstAdmin, runSetup } from "@/server/setup";
import { currentUser } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try { return NextResponse.json({ needsFirstAdmin: await needsFirstAdmin() }); } catch (e) { return errorResponse(e); }
}

/** First run: creates the first administrator. Afterwards: administrators only (re-runs migrations). */
export async function POST(req: NextRequest) {
  try {
    if (await needsFirstAdmin()) {
      const b = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email(), password: z.string().min(12).max(200), demo: z.boolean().default(false) }).parse(await req.json());
      const r = await runSetup({ admin: { name: b.name, email: b.email, password: b.password }, demo: b.demo });
      return NextResponse.json({ ok: true, ...r });
    }
    const u = await currentUser();
    if (u?.role !== "admin") throw new AppError("forbidden", "Setup has already been completed", 403);
    await runSetup({});
    return NextResponse.json({ ok: true, migrated: true });
  } catch (e) { return errorResponse(e); }
}
