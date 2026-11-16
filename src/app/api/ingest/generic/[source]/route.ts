import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { fromGeneric } from "@/server/ingestion/normalize";
import { processEvent } from "@/server/incidents/lifecycle";
import { requireBearer } from "@/server/ingestion/auth";
import { errorResponse } from "@/server/api";

/** Generic ingestion contract for future monitoring systems (docs/INTEGRATIONS.md). */
export async function POST(req: NextRequest, { params }: { params: { source: string } }) {
  try {
    if (!/^[a-z0-9_-]{2,32}$/.test(params.source) || params.source === "netxms" || params.source === "telegram") return NextResponse.json({ error: "bad_source" }, { status: 400 });
    requireBearer(req, "INGEST_TOKEN_GENERIC");
    const r = await processEvent(getDb(), fromGeneric(params.source, await req.json()));
    return NextResponse.json(r, { status: 202 });
  } catch (e) { return errorResponse(e); }
}
