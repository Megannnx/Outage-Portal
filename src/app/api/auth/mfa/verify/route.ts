import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { verifyMfa } from "@/server/auth/session";
import { errorResponse } from "@/server/api";
export async function POST(req: NextRequest) {
  try { await verifyMfa(z.object({ code: z.string().min(6).max(10) }).parse(await req.json()).code); return NextResponse.json({ ok: true }); }
  catch (e) { return errorResponse(e); }
}
