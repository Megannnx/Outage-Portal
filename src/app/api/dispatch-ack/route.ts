import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { acknowledgeDispatchByToken } from "@/server/incidents/actions";
import { errorResponse } from "@/server/api";
/** Public: technicians acknowledge from the link in their dispatch email (token = capability). */
export async function POST(req: NextRequest) {
  try {
    const b = z.object({ token: z.string().min(20).max(100), name: z.string().trim().min(2).max(100) }).parse(await req.json());
    const d = await acknowledgeDispatchByToken(getDb(), b.token, b.name);
    return NextResponse.json({ ok: true, reference: d.reference, acknowledgedAt: d.acknowledgedAt });
  } catch (e) { return errorResponse(e); }
}
