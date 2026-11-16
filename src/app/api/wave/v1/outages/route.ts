import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { requireBearer } from "@/server/ingestion/auth";
import { errorResponse } from "@/server/api";
import { currentOutages } from "@/server/integrations/wave";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  try {
    await requireBearer(req, "waveApi");
    return NextResponse.json({ outages: await currentOutages(getDb()) });
  } catch (e) { return errorResponse(e); }
}
