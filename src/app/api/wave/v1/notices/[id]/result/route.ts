import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { requireBearer } from "@/server/ingestion/auth";
import { errorResponse } from "@/server/api";
import { reportResult } from "@/server/integrations/wave";
export const dynamic = "force-dynamic";
/** Wave reports what happened to a notice it collected. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireBearer(req, "waveApi");
    return NextResponse.json(await reportResult(getDb(), params.id, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
