/**
 * Hosted (serverless) replacement for the always-on worker.
 * Called every ~30 s by Supabase pg_cron (pg_net). Runs due jobs for up to
 * ~45 s, then the escalation/health sweeps (one caller at a time via a lease).
 * Idempotent and safe to call concurrently or late — overdue jobs simply catch up.
 */
import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { runDueJobs, withSweepLock } from "@/server/scheduler/runner";
import { runEscalationSweep, runHealthSweep } from "@/server/escalations/engine";
import { healthOk } from "@/server/lib/alerts";
import { getSecret } from "@/server/lib/secrets";
import { safeEqual } from "@/server/lib/crypto";
import { deliveryMode } from "@/server/comms/adapters";
import { errorResponse } from "@/server/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function tick(req: Request) {
  try {
    const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!got || !safeEqual(got, await getSecret("tickToken"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const db = getDb();
    const started = Date.now();
    let jobs = 0;
    while (Date.now() - started < 45_000) {
      const n = await runDueJobs(db, `vercel:${process.env.VERCEL_REGION ?? "fn"}`);
      jobs += n;
      if (!n) break;
    }
    const swept = await withSweepLock(db, async () => { await runEscalationSweep(db); await runHealthSweep(db); return true; });
    await healthOk(db, "worker", "Scheduler (Supabase cron → tick)", { deliveryMode: deliveryMode(), lastJobs: jobs });
    return NextResponse.json({ ok: true, jobs, swept: !!swept, ms: Date.now() - started });
  } catch (e) { return errorResponse(e); }
}
export const POST = tick;
export const GET = tick;
