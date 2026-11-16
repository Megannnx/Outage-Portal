import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { beginMfaSetup, confirmMfaSetup } from "@/server/auth/session";
import { errorResponse } from "@/server/api";
export const dynamic = "force-dynamic";
export async function GET() { try { return NextResponse.json(await beginMfaSetup()); } catch (e) { return errorResponse(e); } }
export async function POST(req: NextRequest) {
  try { await confirmMfaSetup(z.object({ code: z.string().min(6).max(10) }).parse(await req.json()).code); return NextResponse.json({ ok: true }); }
  catch (e) { return errorResponse(e); }
}
