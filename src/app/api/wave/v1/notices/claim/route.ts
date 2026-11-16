import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { requireBearer } from "@/server/ingestion/auth";
import { errorResponse } from "@/server/api";
import { claimNotices } from "@/server/integrations/wave";
export const dynamic = "force-dynamic";
/** Wave collects resident notices that are ready to send (each is leased to Wave for 5 minutes). */
export async function POST(req: NextRequest) {
  try {
    await requireBearer(req, "waveApi");
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 25);
    return NextResponse.json(await claimNotices(getDb(), Number.isFinite(limit) ? limit : 25));
  } catch (e) { return errorResponse(e); }
}
