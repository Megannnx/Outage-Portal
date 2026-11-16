import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
export const dynamic = "force-dynamic";
/** Liveness/readiness for load balancers and uptime monitors (no sensitive detail). */
export async function GET() {
  try {
    const r = await getDb().execute(sql`select (select last_success_at from integration_health where key='worker') as worker`);
    const w = (r.rows[0] as { worker: string | null }).worker;
    const workerOk = !!w && Date.now() - new Date(w).getTime() < 3 * 60_000;
    return NextResponse.json({ ok: true, db: true, worker: workerOk }, { status: workerOk ? 200 : 503 });
  } catch { return NextResponse.json({ ok: false, db: false }, { status: 503 }); }
}
