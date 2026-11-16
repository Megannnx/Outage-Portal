import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { getSettings } from "@/server/domain/settings";
import { fromNetxms } from "@/server/ingestion/normalize";
import { processEvent } from "@/server/incidents/lifecycle";
import { requireBearer } from "@/server/ingestion/auth";
import { errorResponse } from "@/server/api";
import { healthError } from "@/server/lib/alerts";

/** NetXMS server action → portal. See docs/NETXMS_SETUP.md. Idempotent: NetXMS may retry freely. */
export async function POST(req: NextRequest) {
  const db = getDb();
  try {
    requireBearer(req, "INGEST_TOKEN_NETXMS");
    const raw = await req.text();
    if (raw.length > 20_000) return NextResponse.json({ error: "too_large" }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { await healthError(db, "monitoring:netxms", "NetXMS events", "Malformed JSON from NetXMS"); return NextResponse.json({ error: "bad_json" }, { status: 400 }); }
    const ev = fromNetxms(body, await getSettings(db));
    const r = await processEvent(db, ev);
    return NextResponse.json(r, { status: r.result === "duplicate" ? 200 : 202 });
  } catch (e) { return errorResponse(e); }
}
